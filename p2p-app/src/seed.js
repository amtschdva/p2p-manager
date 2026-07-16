// Database seeding (async / Postgres). Runs on server start if empty.
//
// Two modes:
//  - demo (default in development): full demo data — users, vendors, flows, JEs
//  - production: tax masters + a single admin account with a random password
//    printed once to the log. Active when NODE_ENV=production (set SEED_DEMO=1
//    to force demo data on a production build, e.g. for staging).
//
// CLI: `npm run seed` (--reseed) wipes and rebuilds demo data;
//      `node src/seed.js --production` wipes and initialises for production.
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { db, resetSchema } = require('./db');
const { postInvoiceBookingJE, postPaymentJE, postDepositJE } = require('./journal');
const { createApprovals } = require('./approvals');

const FORCE_PRODUCTION = process.argv.includes('--production');

async function seed() {
  if ((await db.prepare('SELECT COUNT(*) AS c FROM users').get()).c > 0) return;
  const production = FORCE_PRODUCTION || (process.env.NODE_ENV === 'production' && process.env.SEED_DEMO !== '1');
  console.log(production ? 'Initialising production database (no demo data)...' : 'Seeding database with demo data...');
  const hash = (p) => bcrypt.hashSync(p, 10);

  // ---- tax masters (both modes) ----
  const insTds = db.prepare('INSERT INTO tds_sections (section, description, rate) VALUES (?,?,?)');
  for (const [s, d, r] of [
    ['194C', 'Contractors — Individual/HUF', 1],
    ['194C', 'Contractors — Others', 2],
    ['194J', 'Professional fees', 10],
    ['194J', 'Technical services', 2],
    ['194I', 'Rent — Land or building', 10],
    ['194I', 'Rent — Plant & machinery', 2],
    ['194H', 'Commission or brokerage', 2],
    ['194Q', 'Purchase of goods (above threshold)', 0.1],
    ['194A', 'Interest other than securities', 10],
    ['195', 'Payments to non-residents', 10],
  ]) await insTds.run(s, d, r);

  const insRcm = db.prepare('INSERT INTO rcm_categories (name, description) VALUES (?,?)');
  const rcmImport = (await insRcm.run('Import of services', 'Services received from a supplier located outside India')).lastInsertRowid;
  for (const [n, d] of [
    ['Legal services', 'Services by an advocate or firm of advocates'],
    ['Goods Transport Agency (GTA)', 'Transport of goods by road where GTA has not opted for forward charge'],
    ['Sponsorship services', 'Sponsorship provided to a body corporate or partnership firm'],
    ['Director services', 'Services by a director to the company (sitting fees etc.)'],
    ['Security services', 'Security personnel supplied by a non-body-corporate'],
    ['Renting of motor vehicle', 'Passenger vehicle rental from a non-body-corporate not charging 12% GST'],
  ]) await insRcm.run(n, d);

  const insUser = db.prepare('INSERT INTO users (username, password_hash, full_name, email, role) VALUES (?,?,?,?,?)');

  // ---- production: single admin, nothing else ----
  if (production) {
    const initialPassword = 'Admin-' + crypto.randomBytes(4).toString('hex');
    await insUser.run('admin', hash(initialPassword), 'Administrator', null, 'admin');
    console.log('='.repeat(60));
    console.log('Production initialisation complete.');
    console.log(`  Initial admin login:  admin / ${initialPassword}`);
    console.log('  1. Sign in and CHANGE THIS PASSWORD immediately');
    console.log('  2. Enable two-factor auth (sidebar)');
    console.log('  3. Add your GST registrations in Tax Settings');
    console.log('  4. Create staff accounts on the Users page');
    console.log('='.repeat(60));
    return;
  }

  // ---- demo data (development) ----
  const insGstin = db.prepare('INSERT INTO company_gstins (gstin, state_code, state_name, label) VALUES (?,?,?,?)');
  const gstinKA = (await insGstin.run('29ABCDE1234F1Z5', '29', 'Karnataka', 'Bengaluru HO')).lastInsertRowid;
  const gstinMH = (await insGstin.run('27ABCDE1234F1Z3', '27', 'Maharashtra', 'Mumbai Branch')).lastInsertRowid;

  const adminId = (await insUser.run('admin', hash('admin123'), 'Amit Sachdeva', 'amtschdva@gmail.com', 'admin')).lastInsertRowid;
  const proc = (await insUser.run('priya', hash('priya123'), 'Priya Sharma', 'priya@example.com', 'procurement')).lastInsertRowid;
  const fin = (await insUser.run('rahul', hash('rahul123'), 'Rahul Verma', 'rahul@example.com', 'finance')).lastInsertRowid;
  const appr = (await insUser.run('meera', hash('meera123'), 'Meera Iyer', 'meera@example.com', 'approver')).lastInsertRowid;
  const req = (await insUser.run('vikram', hash('vikram123'), 'Vikram Singh', 'vikram@example.com', 'requester')).lastInsertRowid;
  const clerk = (await insUser.run('sneha', hash('sneha123'), 'Sneha Patel', 'sneha@example.com', 'finance')).lastInsertRowid;

  // ---- departments (heads approve their department's PRs) ----
  const insDept = db.prepare('INSERT INTO departments (name, head_user_id) VALUES (?,?)');
  const deptIT = (await insDept.run('IT', appr)).lastInsertRowid;                  // Meera heads IT
  const deptFacilities = (await insDept.run('Facilities', proc)).lastInsertRowid;  // Priya heads Facilities
  await db.prepare('UPDATE departments SET deputy_user_id = ? WHERE id = ?').run(appr, deptFacilities); // Meera is deputy
  const deptFinance = (await insDept.run('Finance', fin)).lastInsertRowid;
  const deptAdminOps = (await insDept.run('Admin & Operations', adminId)).lastInsertRowid;
  const setDept = db.prepare('UPDATE users SET department_id = ? WHERE id = ?');
  await setDept.run(deptIT, req);
  await setDept.run(deptFacilities, proc);
  await setDept.run(deptFinance, fin);
  await setDept.run(deptFinance, clerk);   // Sneha — finance clerk; Rahul is the Finance head
  await setDept.run(deptIT, appr);
  await setDept.run(deptAdminOps, adminId);

  // ---- approval matrix ----
  const insRule = db.prepare(`INSERT INTO approval_rules (doc_type, department_id, min_amount, max_amount, seq, approver_kind, approver_ref)
    VALUES (?,?,?,?,?,?,?)`);
  // Demo Delegation of Authority with amount bands:
  //   PRs      ≤ ₹5,00,000   → department head
  //            > ₹5,00,000   → department head, then admin (CFO stand-in)
  //   Invoices ≤ ₹10,00,000  → department head, then finance (TDS/JE at finance)
  //            > ₹10,00,000  → department head, finance, then admin
  await insRule.run('pr', null, 0, 500000, 1, 'department_head', null);
  await insRule.run('pr', null, 500000.01, null, 1, 'department_head', null);
  await insRule.run('pr', null, 500000.01, null, 2, 'role', 'admin');
  await insRule.run('invoice', null, 0, 1000000, 1, 'department_head', null);
  await insRule.run('invoice', null, 0, 1000000, 2, 'role', 'finance');
  await insRule.run('invoice', null, 1000000.01, null, 1, 'department_head', null);
  await insRule.run('invoice', null, 1000000.01, null, 2, 'role', 'finance');
  await insRule.run('invoice', null, 1000000.01, null, 3, 'role', 'admin');

  // ---- vendors ----
  const insVendor = db.prepare(`INSERT INTO vendors
    (code, name, vendor_type, contact_person, email, phone, address, gstin, pan, bank_name, bank_account, ifsc, payment_terms, currency, status)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const v1 = (await insVendor.run('V-0001', 'TechSupply Solutions Pvt Ltd', 'domestic', 'Anil Kumar', 'sales@techsupply.in', '+91 98100 11111',
    '12 MG Road, Bengaluru, KA 560001', '29AABCT1234F1Z5', 'AABCT1234F', 'HDFC Bank', '50200012345678', 'HDFC0000123', 'Net 30', 'INR', 'active')).lastInsertRowid;
  const v2 = (await insVendor.run('V-0002', 'Office Essentials India', 'domestic', 'Sunita Rao', 'orders@officeessentials.in', '+91 98200 22222',
    '45 Nehru Place, New Delhi, DL 110019', '07AAACO5678G1Z2', 'AAACO5678G', 'ICICI Bank', '001405001234', 'ICIC0000014', 'Net 15', 'INR', 'active')).lastInsertRowid;
  const v3 = (await insVendor.run('V-0003', 'Meridian Industrial Services', 'domestic', 'Joseph Mathew', 'accounts@meridianind.com', '+91 98300 33333',
    '8 Industrial Estate, Pune, MH 411026', '27AADCM9012H1Z8', 'AADCM9012H', 'State Bank of India', '30123456789', 'SBIN0001234', 'Net 45', 'INR', 'active')).lastInsertRowid;
  await insVendor.run('V-0004', 'GreenLine Logistics', 'domestic', 'Farah Khan', 'billing@greenline.co.in', '+91 98400 44444',
    '221 Link Road, Mumbai, MH 400064', '27AAECG3456J1Z1', 'AAECG3456J', 'Axis Bank', '911010012345678', 'UTIB0000456', 'Net 30', 'INR', 'inactive');
  const v5 = (await insVendor.run('V-0005', 'CloudStack Software Inc', 'overseas', 'Sarah Chen', 'billing@cloudstack.io', '+1 415 555 0100',
    '500 Market St, San Francisco, CA, USA', null, null, 'Silicon Valley Bank', 'US-88231001', null, 'Net 30', 'USD', 'active')).lastInsertRowid;

  // pending self-registered vendor
  const nimbusId = (await db.prepare(`INSERT INTO vendors (code, name, contact_person, email, phone, address, gstin, pan, payment_terms, status, verified)
    VALUES (?,?,?,?,?,?,?,?,?,?,0)`)
    .run('V-0006', 'Nimbus Cloud Services', 'Deepak Nair', 'deepak@nimbuscloud.in', '+91 98500 55555',
         '3rd Floor, Cyber Towers, Hyderabad, TS 500081', '36AAFCN7890K1Z3', 'AAFCN7890K', 'Net 30', 'inactive')).lastInsertRowid;

  const insVendorUser = db.prepare('INSERT INTO vendor_users (vendor_id, email, password_hash, full_name) VALUES (?,?,?,?)');
  await insVendorUser.run(v1, 'vendor@techsupply.in', hash('vendor123'), 'Anil Kumar');
  await insVendorUser.run(nimbusId, 'deepak@nimbuscloud.in', hash('nimbus123'), 'Deepak Nair');

  // ---- P2P documents ----
  const insPr = db.prepare(`INSERT INTO prs (pr_number, requester_id, department, department_id, needed_by, justification, status, approver_id, approved_at, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`);
  const insPrItem = db.prepare('INSERT INTO pr_items (pr_id, description, quantity, unit, est_unit_price) VALUES (?,?,?,?,?)');
  const insPo = db.prepare(`INSERT INTO pos (po_number, pr_id, vendor_id, company_gstin_id, created_by, status, expected_date, notes, created_at)
    VALUES (?,?,?,?,?,?,?,?,?)`);
  const insPoItem = db.prepare('INSERT INTO po_items (po_id, description, quantity, unit, unit_price) VALUES (?,?,?,?,?)');
  const insGrn = db.prepare(`INSERT INTO grns (grn_number, po_id, received_by, received_date, notes, status, approved_by, approved_at)
    VALUES (?,?,?,?,?,'approved',?,to_char(now(), 'YYYY-MM-DD HH24:MI:SS'))`);
  const insGrnItem = db.prepare('INSERT INTO grn_items (grn_id, po_item_id, quantity_received, condition_notes) VALUES (?,?,?,?)');
  const insInv = db.prepare(`INSERT INTO invoices
    (invoice_number, vendor_invoice_ref, po_id, vendor_id, company_gstin_id, invoice_date, due_date,
     subtotal, cgst_amount, sgst_amount, igst_amount, tax_amount, total,
     rcm, rcm_category_id, itc_eligibility, tds_section, tds_rate, tds_amount,
     currency, fx_rate, foreign_amount, status, match_status, gstr2b_status, created_by, approved_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insPay = db.prepare(`INSERT INTO payments (payment_number, invoice_id, amount, payment_date, method, reference, created_by, status, released_by, released_at)
    VALUES (?,?,?,?,?,?,?,'released',?,to_char(now(), 'YYYY-MM-DD HH24:MI:SS'))`);

  const bookAndLink = async (invId, userId) => {
    const inv = await db.prepare('SELECT * FROM invoices WHERE id = ?').get(invId);
    const { jeId } = await postInvoiceBookingJE(inv, userId);
    await db.prepare('UPDATE invoices SET booking_je_id = ? WHERE id = ?').run(jeId, invId);
  };
  const payAndLink = async (payId, userId) => {
    const p = await db.prepare('SELECT * FROM payments WHERE id = ?').get(payId);
    const inv = await db.prepare('SELECT * FROM invoices WHERE id = ?').get(p.invoice_id);
    const { jeId } = await postPaymentJE(p, inv, userId);
    await db.prepare('UPDATE payments SET je_id = ? WHERE id = ?').run(jeId, payId);
  };

  // --- Flow 1: laptops, intra-state (KA vendor / KA HO), 194Q, fully paid ---
  const pr1 = (await insPr.run('PR-2026-0001', req, 'IT', deptIT, '2026-05-15', 'Laptops for new engineering hires', 'converted', appr, '2026-04-20 10:00:00', '2026-04-18 09:00:00')).lastInsertRowid;
  await insPrItem.run(pr1, 'Dell Latitude 5450 Laptop', 10, 'EA', 85000);
  await insPrItem.run(pr1, 'Laptop docking station', 10, 'EA', 12000);
  const po1 = (await insPo.run('PO-2026-0001', pr1, v1, gstinKA, proc, 'received', '2026-05-10', 'Deliver to Bengaluru office', '2026-04-22 11:00:00')).lastInsertRowid;
  const po1i1 = (await insPoItem.run(po1, 'Dell Latitude 5450 Laptop', 10, 'EA', 84500)).lastInsertRowid;
  const po1i2 = (await insPoItem.run(po1, 'Laptop docking station', 10, 'EA', 11800)).lastInsertRowid;
  const grn1 = (await insGrn.run('GRN-2026-0001', po1, proc, '2026-05-08', 'All items received in good condition', appr)).lastInsertRowid;
  await insGrnItem.run(grn1, po1i1, 10, null);
  await insGrnItem.run(grn1, po1i2, 10, null);
  // subtotal 963000 · CGST 86670 + SGST 86670 · TDS 194Q @0.1% = 963 · net payable 1135377
  const inv1 = (await insInv.run('INV-2026-0001', 'TS/2026/1189', po1, v1, gstinKA, '2026-05-10', '2026-06-09',
    963000, 86670, 86670, 0, 173340, 1136340,
    0, null, 'eligible', '194Q', 0.1, 963,
    'INR', null, null, 'paid', 'matched', 'pending', fin, appr)).lastInsertRowid;
  await bookAndLink(inv1, fin);
  const pay1 = (await insPay.run('PAY-2026-0001', inv1, 1135377, '2026-06-05', 'bank_transfer', 'UTR26060512345', fin, appr)).lastInsertRowid;
  await payAndLink(pay1, fin);

  // --- Flow 2: office supplies, inter-state (DL vendor / KA HO), 194Q, partially paid ---
  const pr2 = (await insPr.run('PR-2026-0002', req, 'Admin & Operations', deptAdminOps, '2026-06-01', 'Quarterly office supplies replenishment', 'converted', appr, '2026-05-12 15:30:00', '2026-05-10 14:00:00')).lastInsertRowid;
  await insPrItem.run(pr2, 'A4 paper (500 sheet ream)', 200, 'EA', 280);
  await insPrItem.run(pr2, 'Whiteboard markers (box of 10)', 30, 'BOX', 450);
  const po2 = (await insPo.run('PO-2026-0002', pr2, v2, gstinKA, proc, 'received', '2026-05-28', null, '2026-05-13 10:00:00')).lastInsertRowid;
  const po2i1 = (await insPoItem.run(po2, 'A4 paper (500 sheet ream)', 200, 'EA', 275)).lastInsertRowid;
  const po2i2 = (await insPoItem.run(po2, 'Whiteboard markers (box of 10)', 30, 'BOX', 440)).lastInsertRowid;
  const grn2 = (await insGrn.run('GRN-2026-0002', po2, proc, '2026-05-26', null, appr)).lastInsertRowid;
  await insGrnItem.run(grn2, po2i1, 200, null);
  await insGrnItem.run(grn2, po2i2, 30, null);
  // subtotal 68200 · IGST 12276 · TDS 194Q @0.1% = 68.20 · net payable 80407.80
  const inv2 = (await insInv.run('INV-2026-0002', 'OE-8834', po2, v2, gstinKA, '2026-05-30', '2026-06-14',
    68200, 0, 0, 12276, 12276, 80476,
    0, null, 'eligible', '194Q', 0.1, 68.2,
    'INR', null, null, 'partially_paid', 'matched', 'pending', fin, appr)).lastInsertRowid;
  await bookAndLink(inv2, fin);
  const pay2 = (await insPay.run('PAY-2026-0002', inv2, 40000, '2026-06-20', 'upi', 'UPI-REF-778812', fin, appr)).lastInsertRowid;
  await payAndLink(pay2, fin);

  // --- Flow 3: HVAC maintenance, intra-state on the MH registration, invoice awaiting approval ---
  const pr3 = (await insPr.run('PR-2026-0003', proc, 'Facilities', deptFacilities, '2026-07-10', 'HVAC annual maintenance and spare parts', 'converted', appr, '2026-06-05 09:15:00', '2026-06-03 16:00:00')).lastInsertRowid;
  await insPrItem.run(pr3, 'HVAC maintenance service (per unit)', 12, 'EA', 6500);
  await insPrItem.run(pr3, 'Replacement air filters', 24, 'EA', 1200);
  const po3 = (await insPo.run('PO-2026-0003', pr3, v3, gstinMH, proc, 'partially_received', '2026-07-05', 'Service to be scheduled per floor', '2026-06-06 11:30:00')).lastInsertRowid;
  const po3i1 = (await insPoItem.run(po3, 'HVAC maintenance service (per unit)', 12, 'EA', 6500)).lastInsertRowid;
  const po3i2 = (await insPoItem.run(po3, 'Replacement air filters', 24, 'EA', 1150)).lastInsertRowid;
  const grn3 = (await insGrn.run('GRN-2026-0003', po3, proc, '2026-06-25', 'First 6 units serviced, filters delivered', appr)).lastInsertRowid;
  await insGrnItem.run(grn3, po3i1, 6, null);
  await insGrnItem.run(grn3, po3i2, 24, null);
  const inv3 = (await insInv.run('INV-2026-0003', 'MIS/26-27/044', po3, v3, gstinMH, '2026-06-28', '2026-08-12',
    66600, 5994, 5994, 0, 11988, 78588,
    0, null, 'eligible', null, 0, 0,
    'INR', null, null, 'pending', 'unmatched', 'pending', fin, null)).lastInsertRowid;
  await db.prepare('UPDATE invoices SET department_id = ? WHERE id = ?').run(deptFacilities, inv3);
  await createApprovals('invoice', inv3, deptFacilities, 78588); // Facilities head first, then finance

  // --- Flow 4: overseas SaaS vendor — import of services under RCM, TDS u/s 195 ---
  const po4 = (await insPo.run('PO-2026-0004', null, v5, gstinKA, proc, 'received', '2026-06-20', 'Annual cloud platform subscription', '2026-06-10 09:00:00')).lastInsertRowid;
  const po4i1 = (await insPoItem.run(po4, 'Cloud platform subscription (annual)', 1, 'EA', 201600)).lastInsertRowid;
  const grn4 = (await insGrn.run('GRN-2026-0004', po4, proc, '2026-06-25', 'Service activated', appr)).lastInsertRowid;
  await insGrnItem.run(grn4, po4i1, 1, null);
  // USD 2,400 @ ₹84 = ₹201,600 · RCM IGST 18% = 36,288 (not payable to vendor) · TDS 195 @10% = 20,160
  const inv4 = (await insInv.run('INV-2026-0004', 'CS-INV-20447', po4, v5, gstinKA, '2026-06-28', '2026-07-28',
    201600, 0, 0, 36288, 36288, 201600,
    1, rcmImport, 'eligible', '195', 10, 20160,
    'USD', 84, 2400, 'approved', 'matched', 'na', fin, appr)).lastInsertRowid;
  await bookAndLink(inv4, fin);

  // --- TDS deposit for May (194Q from flows 1 & 2), challan recorded ---
  const dep1 = (await db.prepare(`INSERT INTO tds_deposits (deposit_number, kind, period, section, amount, challan_no, bsr_code, deposit_date, created_by)
    VALUES ('DEP-2026-0001','tds','2026-05','194Q',1031.2,'05100123','0240001','2026-06-05',?)`).run(fin)).lastInsertRowid;
  {
    const dep = await db.prepare('SELECT * FROM tds_deposits WHERE id = ?').get(dep1);
    const { jeId } = await postDepositJE(dep, fin);
    await db.prepare('UPDATE tds_deposits SET je_id = ? WHERE id = ?').run(jeId, dep1);
  }

  // --- open PRs ---
  const pr4 = (await insPr.run('PR-2026-0004', req, 'IT', deptIT, '2026-08-01', 'Monitors for design team', 'submitted', null, null, '2026-07-01 10:00:00')).lastInsertRowid;
  await insPrItem.run(pr4, '27-inch 4K monitor', 8, 'EA', 32000);
  await createApprovals('pr', pr4, deptIT, 8 * 32000); // awaiting the IT department head (Meera)
  const pr5 = (await insPr.run('PR-2026-0005', proc, 'Admin & Operations', deptAdminOps, '2026-07-25', 'Warehouse shelving units', 'approved', appr, '2026-06-30 12:00:00', '2026-06-28 09:30:00')).lastInsertRowid;
  await insPrItem.run(pr5, 'Heavy-duty shelving unit 5-tier', 15, 'EA', 8500);

  console.log('Seed complete. Staff login: admin/admin123 · Vendor portal: vendor@techsupply.in/vendor123');
}

// CLI: node src/seed.js --reseed | --production
if (require.main === module) {
  (async () => {
    await resetSchema();
    console.log('Database schema reset.');
    await seed();
    process.exit(0);
  })().catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { seed };
