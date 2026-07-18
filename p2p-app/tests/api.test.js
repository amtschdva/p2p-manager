// End-to-end API tests. Spawns the real server against an isolated temp data
// directory (fresh demo seed) and exercises the business flows over HTTP.
// Engine-agnostic: the same suite must pass on SQLite and Postgres.
//
// Run:  npm test
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = process.env.TEST_PORT || 3456;
const BASE = `http://localhost:${PORT}`;
const APP_ROOT = path.join(__dirname, '..');
// dedicated test database — never touches the dev one
const TEST_DB = process.env.TEST_DATABASE_URL || 'postgres://p2p:p2p@localhost:5433/p2p_test';

let child;
let tmpDir;
const tokens = {}; // cached logins — stay under the rate limit

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p2p-test-'));
  const env = {
    ...process.env,
    PORT: String(PORT),
    P2P_DATA_DIR: tmpDir,
    DATABASE_URL: TEST_DB,
    JWT_SECRET: 'test-secret-for-suite',
    NODE_ENV: 'development',
  };
  // fresh schema + demo seed for every run
  const reset = spawnSync(process.execPath, ['src/seed.js', '--reseed'], { cwd: APP_ROOT, env, encoding: 'utf8' });
  if (reset.status !== 0) throw new Error('DB reset failed:\n' + reset.stdout + reset.stderr);
  child = spawn(process.execPath, ['src/server.js'], {
    cwd: APP_ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let bootLog = '';
  child.stdout.on('data', (d) => { bootLog += d; });
  child.stderr.on('data', (d) => { bootLog += d; });
  // wait for the server to answer
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${BASE}/api/auth/me`);
      if (r.status === 401) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('Server did not start:\n' + bootLog);
});

after(() => {
  if (child) child.kill();
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function call(method, apiPath, { token, body, form } = {}) {
  const headers = {};
  if (token) headers.Authorization = 'Bearer ' + token;
  let payload;
  if (form) {
    payload = form;
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(BASE + apiPath, { method, headers, body: payload });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* csv or file */ }
  return { status: res.status, json, text };
}

async function login(username, password) {
  if (tokens[username]) return tokens[username];
  const r = await call('POST', '/api/auth/login', { body: { username, password } });
  assert.equal(r.status, 200, `login ${username}: ${r.text}`);
  tokens[username] = r.json.token;
  return r.json.token;
}

const pdfBlob = () => new Blob(['%PDF-1.4 test document'], { type: 'application/pdf' });

// ---------------------------------------------------------------------------

test('auth: wrong password rejected, valid login works', async () => {
  const bad = await call('POST', '/api/auth/login', { body: { username: 'vikram', password: 'nope' } });
  assert.equal(bad.status, 401);
  const tok = await login('vikram', 'vikram123');
  const me = await call('GET', '/api/auth/me', { token: tok });
  assert.equal(me.status, 200);
  assert.equal(me.json.username, 'vikram');
});

test('auth: vendor tokens cannot reach staff APIs and vice versa', async () => {
  const v = await call('POST', '/api/vendor/login', { body: { email: 'vendor@techsupply.in', password: 'vendor123' } });
  assert.equal(v.status, 200);
  tokens.__vendor = v.json.token;
  const staffApi = await call('GET', '/api/invoices', { token: tokens.__vendor });
  assert.equal(staffApi.status, 403);
  const vikram = await login('vikram', 'vikram123');
  const vendorApi = await call('GET', '/api/vendor/pos', { token: vikram });
  assert.equal(vendorApi.status, 403);
  const noAuth = await call('GET', '/api/vendors');
  assert.equal(noAuth.status, 401);
});

let smallPrId;
test('PR: routes to department head; wrong approver blocked; head approves', async () => {
  const vikram = await login('vikram', 'vikram123');
  const create = await call('POST', '/api/prs', {
    token: vikram,
    body: { justification: 'test PR', items: [{ description: 'Widget', quantity: 3, unit: 'EA', est_unit_price: 20000 }] },
  });
  assert.equal(create.status, 201, create.text);
  smallPrId = create.json.id;

  const rahul = await login('rahul', 'rahul123');
  const wrong = await call('POST', `/api/prs/${smallPrId}/approve`, { token: rahul, body: {} });
  assert.equal(wrong.status, 400);
  assert.match(wrong.json.error, /awaiting/i);

  const meera = await login('meera', 'meera123');
  const ok = await call('POST', `/api/prs/${smallPrId}/approve`, { token: meera, body: {} });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.finished, true);

  const detail = await call('GET', `/api/prs/${smallPrId}`, { token: vikram });
  assert.equal(detail.json.status, 'approved');
});

test('PR: amount bands — above ₹5 lakh escalates to a second (admin) level', async () => {
  const vikram = await login('vikram', 'vikram123');
  const create = await call('POST', '/api/prs', {
    token: vikram,
    body: { justification: 'big PR', items: [{ description: 'Server', quantity: 2, unit: 'EA', est_unit_price: 400000 }] },
  });
  const id = create.json.id;
  const detail = await call('GET', `/api/prs/${id}`, { token: vikram });
  assert.equal(detail.json.approval_chain.length, 2);
  assert.equal(detail.json.approval_chain[0].approver_kind, 'department_head');
  assert.equal(detail.json.approval_chain[1].approver_ref, 'admin');

  const meera = await login('meera', 'meera123');
  const l1 = await call('POST', `/api/prs/${id}/approve`, { token: meera, body: {} });
  assert.equal(l1.json.finished, false);
  const admin = await login('admin', 'admin123');
  const l2 = await call('POST', `/api/prs/${id}/approve`, { token: admin, body: {} });
  assert.equal(l2.json.finished, true);
});

test('matrix governance: chain preview, deputy resolution, overlap rejection', async () => {
  const vikram = await login('vikram', 'vikram123');
  // small PR in Facilities (dept 2): head OR deputy can act
  const small = await call('GET', '/api/approvals/preview?doc_type=pr&department_id=2&amount=1000', { token: vikram });
  assert.equal(small.json.length, 1);
  assert.match(small.json[0].label, /deputy Meera/i);
  // big amount escalates
  const big = await call('GET', '/api/approvals/preview?doc_type=pr&department_id=2&amount=600001', { token: vikram });
  assert.equal(big.json.length, 2);
  // invoices above ₹10 lakh get a third level
  const inv = await call('GET', '/api/approvals/preview?doc_type=invoice&department_id=1&amount=1500000', { token: vikram });
  assert.equal(inv.json.length, 3);

  // overlapping band rejected
  const admin = await login('admin', 'admin123');
  const overlap = await call('POST', '/api/settings/approval-rules', {
    token: admin,
    body: { doc_type: 'pr', department_id: '', min_amount: 400000, max_amount: 700000, seq: 1, approver_kind: 'role', approver_ref: 'approver' },
  });
  assert.equal(overlap.status, 400);
  assert.match(overlap.json.error, /overlap/i);
});

let vendorId;
test('vendor KYC: unverified until required docs uploaded; only finance verifies', async () => {
  const vikram = await login('vikram', 'vikram123');
  const create = await call('POST', '/api/vendors', {
    token: vikram,
    body: { name: 'Test Traders', pan: 'ABCDT9999T', bank_name: 'Test Bank', bank_account: '123', ifsc: 'TEST0000001' },
  });
  assert.equal(create.status, 201, create.text);
  vendorId = create.json.id;

  const rahul = await login('rahul', 'rahul123');
  const early = await call('POST', `/api/vendors/${vendorId}/verify`, { token: rahul, body: {} });
  assert.equal(early.status, 400);
  assert.match(early.json.error, /missing documents/i);

  for (const docType of ['pan', 'cancelled_cheque']) {
    const form = new FormData();
    form.append('doc_type', docType);
    form.append('file', pdfBlob(), 'doc.pdf');
    const up = await call('POST', `/api/vendors/${vendorId}/documents`, { token: vikram, form });
    assert.equal(up.status, 201, up.text);
  }

  const priya = await login('priya', 'priya123');
  const notFinance = await call('POST', `/api/vendors/${vendorId}/verify`, { token: priya, body: {} });
  assert.equal(notFinance.status, 403);

  // AP account code (the GL control account for this vendor) is required at verification
  const noApCode = await call('POST', `/api/vendors/${vendorId}/verify`, { token: rahul, body: {} });
  assert.equal(noApCode.status, 400);
  assert.match(noApCode.json.error, /AP account code/i);

  const ok = await call('POST', `/api/vendors/${vendorId}/verify`, { token: rahul, body: { ap_account_code: 'AP-TESTTRADERS' } });
  assert.equal(ok.status, 200, ok.text);
});

let poId, poItemId;
test('PO & GRN: over-receipt blocked; receipt counts only after approval', async () => {
  const priya = await login('priya', 'priya123');
  const create = await call('POST', '/api/pos', {
    token: priya,
    body: { vendor_id: vendorId, company_gstin_id: 1, items: [{ description: 'Cable', quantity: 10, unit: 'EA', unit_price: 100 }] },
  });
  assert.equal(create.status, 201, create.text);
  poId = create.json.id;
  const detail = await call('GET', `/api/pos/${poId}`, { token: priya });
  poItemId = detail.json.items[0].id;

  const grn = await call('POST', '/api/grns', {
    token: priya,
    body: { po_id: poId, items: [{ po_item_id: poItemId, quantity_received: 8 }] },
  });
  assert.equal(grn.status, 201);
  assert.equal(grn.json.status, 'pending');

  const over = await call('POST', '/api/grns', {
    token: priya,
    body: { po_id: poId, items: [{ po_item_id: poItemId, quantity_received: 5 }] },
  });
  assert.equal(over.status, 400);
  assert.match(over.json.error, /exceed/i);

  const meera = await login('meera', 'meera123');
  const approve = await call('POST', `/api/grns/${grn.json.id}/approve`, { token: meera, body: {} });
  assert.equal(approve.status, 200);
  const after = await call('GET', `/api/pos/${poId}`, { token: priya });
  assert.equal(after.json.status, 'partially_received');
  assert.equal(after.json.items[0].received_qty, 8);
});

let invoiceId, netPayable;
test('invoice: 3-way match, SoD, TDS at final approval, balanced JE posted', async () => {
  const sneha = await login('sneha', 'sneha123');
  const rahul = await login('rahul', 'rahul123');
  const create = await call('POST', '/api/invoices', {
    token: sneha,
    body: { po_id: poId, vendor_invoice_ref: 'TT/001', invoice_date: '2026-07-15', subtotal: 800, igst_amount: 144 },
  });
  assert.equal(create.status, 201, create.text);
  assert.equal(create.json.match_status, 'matched');
  invoiceId = create.json.id;

  // chain: level 1 = uploader's department head, level 2 = finance final
  const detail = await call('GET', `/api/invoices/${invoiceId}`, { token: sneha });
  assert.equal(detail.json.approval_chain.length, 2);
  assert.equal(detail.json.approval_chain[0].approver_kind, 'department_head');
  assert.equal(detail.json.my_action, null); // SoD: creator sees no action

  // segregation of duties: sneha entered it, so she cannot approve any level
  const sod = await call('POST', `/api/invoices/${invoiceId}/approve`, { token: sneha, body: {} });
  assert.equal(sod.status, 400);
  assert.match(sod.json.error, /segregation/i);

  const l1 = await call('POST', `/api/invoices/${invoiceId}/approve`, { token: rahul, body: {} });
  assert.equal(l1.status, 200, l1.text);
  assert.equal(l1.json.finished, false);

  const approve = await call('POST', `/api/invoices/${invoiceId}/approve`, {
    token: rahul,
    body: { tds_section: '194C', tds_rate: 2, itc_eligibility: 'eligible' },
  });
  assert.equal(approve.status, 200, approve.text);
  assert.equal(approve.json.tdsAmount, 16);
  netPayable = approve.json.netPayable;
  assert.equal(netPayable, 928); // 944 total − 16 TDS

  const journal = await call('GET', '/api/journal', { token: rahul });
  const je = journal.json.find((j) => j.je_number === approve.json.jeNumber);
  assert.ok(je, 'booking JE present');
  const dr = je.lines.reduce((s, l) => s + l.debit, 0);
  const cr = je.lines.reduce((s, l) => s + l.credit, 0);
  assert.ok(Math.abs(dr - cr) < 0.01, `JE balanced (Dr ${dr} vs Cr ${cr})`);
  const apGross = je.lines.find((l) => l.account_code === '2100' && l.credit === 944);
  const tdsLine = je.lines.find((l) => l.account_code === '2100' && l.debit === 16 && l.tds_section === '194C');
  assert.ok(apGross, 'AP credited gross');
  assert.ok(tdsLine, 'separate TDS line in AP');
});

test('payments: maker-checker enforced, bank file exported, release settles invoice', async () => {
  const rahul = await login('rahul', 'rahul123');
  const prepare = await call('POST', '/api/payments', { token: rahul, body: { invoice_id: invoiceId, amount: 500 } });
  assert.equal(prepare.status, 201, prepare.text);
  assert.equal(prepare.json.status, 'pending_release');
  const payId = prepare.json.id;

  const detail1 = await call('GET', `/api/invoices/${invoiceId}`, { token: rahul });
  assert.equal(detail1.json.status, 'approved'); // untouched until release
  assert.equal(detail1.json.paid_amount, 0);

  const over = await call('POST', '/api/payments', { token: rahul, body: { invoice_id: invoiceId, amount: 500 } });
  assert.equal(over.status, 400); // 428 remaining after the pending 500

  const self = await call('POST', `/api/payments/${payId}/release`, { token: rahul, body: {} });
  assert.equal(self.status, 400);
  assert.match(self.json.error, /maker-checker/i);

  const sneha = await login('sneha', 'sneha123'); // finance clerk, not the head
  const notHead = await call('POST', `/api/payments/${payId}/release`, { token: sneha, body: {} });
  assert.equal(notHead.status, 400);
  assert.match(notHead.json.error, /finance department head/i);

  const bank = await call('GET', `/api/payments/export-bank?token=${encodeURIComponent(rahul)}`);
  assert.equal(bank.status, 200);
  assert.match(bank.text, /beneficiary_name/);
  assert.match(bank.text, /Test Traders/);

  const admin = await login('admin', 'admin123');
  const release = await call('POST', `/api/payments/${payId}/release`, { token: admin, body: { reference: 'UTR-TEST' } });
  assert.equal(release.status, 200, release.text);
  assert.ok(release.json.jeNumber);

  const detail2 = await call('GET', `/api/invoices/${invoiceId}`, { token: rahul });
  assert.equal(detail2.json.status, 'partially_paid');
  assert.equal(detail2.json.paid_amount, 500);
});

test('GSTR-2B: CSV import reconciles seeded May invoices', async () => {
  const rahul = await login('rahul', 'rahul123');
  const csv = ['supplier_gstin,invoice_no,invoice_date,taxable_value,cgst,sgst,igst',
    '29AABCT1234F1Z5,TS/2026/1189,2026-05-10,963000,86670,86670,0',
    '07AAACO5678G1Z2,OE-8834,2026-05-30,68200,0,0,12376'].join('\n');
  const form = new FormData();
  form.append('company_gstin_id', '1');
  form.append('period', '2026-05');
  form.append('file', new Blob([csv], { type: 'text/csv' }), '2b.csv');
  const imp = await call('POST', '/api/gst/gstr2b/import', { token: rahul, form });
  assert.equal(imp.status, 200, imp.text);
  assert.equal(imp.json.matched, 1);
  assert.equal(imp.json.mismatched, 1); // IGST off by 100 in the CSV
});

test('my-approvals inbox and mail outbox are populated', async () => {
  const meera = await login('meera', 'meera123');
  const inbox = await call('GET', '/api/my-approvals', { token: meera });
  assert.equal(inbox.status, 200);
  assert.ok(inbox.json.prs.some((p) => p.number === 'PR-2026-0004'), 'seeded PR awaiting IT head');

  const admin = await login('admin', 'admin123');
  const outbox = await call('GET', '/api/settings/outbox', { token: admin });
  assert.ok(outbox.json.length > 0, 'notifications recorded');
  assert.ok(outbox.json.every((m) => ['logged', 'sent', 'queued', 'failed'].includes(m.status)));
});

test('vendor portal password: finance resets it, vendor changes it back', async () => {
  // seeded portal login vendor@techsupply.in (vendor id 1) / vendor123
  const vikram = await login('vikram', 'vikram123');
  const notFinance = await call('POST', '/api/vendors/1/portal-password', { token: vikram, body: { new_password: 'newpass123' } });
  assert.equal(notFinance.status, 403, 'only finance/admin may reset');

  const rahul = await login('rahul', 'rahul123');
  const weak = await call('POST', '/api/vendors/1/portal-password', { token: rahul, body: { new_password: 'short' } });
  assert.equal(weak.status, 400, 'password policy enforced');

  const reset = await call('POST', '/api/vendors/1/portal-password', { token: rahul, body: { new_password: 'newpass123' } });
  assert.equal(reset.status, 200, reset.text);
  assert.equal(reset.json.email, 'vendor@techsupply.in');

  const oldPw = await call('POST', '/api/vendor/login', { body: { email: 'vendor@techsupply.in', password: 'vendor123' } });
  assert.equal(oldPw.status, 401, 'old password no longer works');
  const newPw = await call('POST', '/api/vendor/login', { body: { email: 'vendor@techsupply.in', password: 'newpass123' } });
  assert.equal(newPw.status, 200, 'reset password works');

  // vendor changes it themselves from the portal
  const change = await call('POST', '/api/vendor/change-password', {
    token: newPw.json.token, body: { current_password: 'newpass123', new_password: 'vendor123' },
  });
  assert.equal(change.status, 200, change.text);
  // (not re-logging in here — the suite sits close to the login rate limit,
  // and a wrong current_password is already proven rejected below)
  const wrongCurrent = await call('POST', '/api/vendor/change-password', {
    token: newPw.json.token, body: { current_password: 'nope', new_password: 'whatever123' },
  });
  assert.equal(wrongCurrent.status, 400, 'change requires the current password');
});

test('GL integration: mandatory GST fields, due-date auto-calc, GL codes flow onto the JE', async () => {
  const priya = await login('priya', 'priya123');
  const rahul = await login('rahul', 'rahul123');

  // GST-registered vendor with a 45-day payment term and an AP account code
  const vCreate = await call('POST', '/api/vendors', {
    token: priya,
    body: { name: 'GL Test Vendor', gstin: '29AABCT5555F1Z5', pan: 'AABCT5555F', bank_name: 'Test Bank', bank_account: '999', ifsc: 'TEST0000002' },
  });
  assert.equal(vCreate.status, 201, vCreate.text);
  const glVendorId = vCreate.json.id;
  for (const docType of ['pan', 'cancelled_cheque', 'gstin']) {
    const form = new FormData();
    form.append('doc_type', docType);
    form.append('file', pdfBlob(), 'doc.pdf');
    await call('POST', `/api/vendors/${glVendorId}/documents`, { token: priya, form });
  }
  // AP account code is assigned at verification time — the vendor's GL control account
  const vVerify = await call('POST', `/api/vendors/${glVendorId}/verify`, { token: rahul, body: { ap_account_code: 'AP-GLTEST' } });
  assert.equal(vVerify.status, 200, vVerify.text);
  const vUpdate = await call('PUT', `/api/vendors/${glVendorId}`, {
    token: rahul, body: { payment_terms_days: 45 },
  });
  assert.equal(vUpdate.status, 200, vUpdate.text);

  // AP account codes are unique per vendor — assigning an already-used code elsewhere is rejected
  const dupApCode = await call('PUT', '/api/vendors/1', { token: rahul, body: { ap_account_code: 'AP-GLTEST' } });
  assert.equal(dupApCode.status, 400);
  assert.match(dupApCode.json.error, /already assigned/i);

  // Settings CRUD: AP code master, sub-location, cost-centre, custom field label,
  // GSTIN GL codes, TDS section account code
  const admin = await login('admin', 'admin123');
  assert.equal((await call('POST', '/api/settings/ap-account-codes', { token: admin, body: { code: 'AP-GLTEST', name: 'GL Test Vendor AP' } })).status, 201);
  assert.equal((await call('POST', '/api/settings/sub-locations', { token: admin, body: { code: 'SL-01', name: 'Head Office' } })).status, 201);
  assert.equal((await call('POST', '/api/settings/cost-centres', { token: admin, body: { code: 'CC-01', name: 'IT Ops' } })).status, 201);
  const labelRes = await call('PUT', '/api/settings/custom-field-labels', { token: admin, body: { custom_field_1: 'Project Code' } });
  assert.equal(labelRes.status, 200, labelRes.text);
  const labels = await call('GET', '/api/settings/custom-field-labels', { token: admin });
  assert.equal(labels.json.custom_field_1, 'Project Code');
  const gstinRes = await call('PUT', '/api/settings/gstins/1', {
    token: admin, body: { gst_input_igst_code: 'GL-INPUT-IGST', gst_payable_igst_code: 'GL-PAYABLE-IGST' },
  });
  assert.equal(gstinRes.status, 200, gstinRes.text);
  const tdsSecRes = await call('POST', '/api/settings/tds-sections', { token: admin, body: { section: '194Q', description: 'Purchase of goods', rate: 0.1, account_code: 'TDS-194Q' } });
  assert.equal(tdsSecRes.status, 201, tdsSecRes.text);

  // PO + invoice: place of supply / HSN are mandatory for this GST-registered vendor
  const poRes = await call('POST', '/api/pos', {
    token: priya, body: { vendor_id: glVendorId, company_gstin_id: 1, items: [{ description: 'License', quantity: 1, unit: 'EA', unit_price: 100000 }] },
  });
  assert.equal(poRes.status, 201, poRes.text);
  const glPoId = poRes.json.id;

  const sneha = await login('sneha', 'sneha123');
  const missingFields = await call('POST', '/api/invoices', {
    token: sneha, body: { po_id: glPoId, invoice_date: '2026-07-01', subtotal: 100000, igst_amount: 18000 },
  });
  assert.equal(missingFields.status, 400);
  assert.match(missingFields.json.error, /Place of Supply|HSN/i);

  const invRes = await call('POST', '/api/invoices', {
    token: sneha,
    body: {
      po_id: glPoId, invoice_date: '2026-07-01', received_date: '2026-07-05', subtotal: 100000, igst_amount: 18000,
      place_of_supply_code: '29', hsn_sac_code: '998314', gl_description: 'GL integration test invoice',
    },
  });
  assert.equal(invRes.status, 201, invRes.text);
  const glInvoiceId = invRes.json.id;

  const detail = await call('GET', `/api/invoices/${glInvoiceId}`, { token: rahul });
  assert.equal(detail.json.place_of_supply_state, 'Karnataka');
  // due date auto-calculated: received_date (2026-07-05) + 45 days
  assert.equal(detail.json.due_date, '2026-08-19');
  // this invoice's chain is 2 levels (dept head, then finance final) — clear level 1 first
  assert.equal(detail.json.approval_chain.length, 2);
  const l1 = await call('POST', `/api/invoices/${glInvoiceId}/approve`, { token: rahul, body: {} });
  assert.equal(l1.status, 200, l1.text);
  assert.equal(l1.json.finished, false);

  // final approval: TDS + GL classification fields
  const approve = await call('POST', `/api/invoices/${glInvoiceId}/approve`, {
    token: rahul,
    body: {
      tds_section: '194Q', tds_rate: 0.1, itc_eligibility: 'eligible',
      sub_location: 'SL-01', cost_centre: 'CC-01', program_product_code: 'PRD-9', gl_period: '2026-07',
      custom_field_1: 'PRJ-42',
    },
  });
  assert.equal(approve.status, 200, approve.text);

  const journal = await call('GET', '/api/journal', { token: rahul });
  const je = journal.json.find((j) => j.je_number === approve.json.jeNumber);
  assert.ok(je, 'booking JE present');
  assert.equal(je.gl_period, '2026-07');
  const apLine = je.lines.find((l) => l.account_code === '2100' && l.credit > 0);
  const gstInputLine = je.lines.find((l) => l.account_code === '1412'); // GST_INPUT_IGST
  const tdsLine = je.lines.find((l) => l.account_code === '2200');
  assert.equal(apLine.gl_account_code, 'AP-GLTEST', 'AP line carries the vendor GL code');
  assert.equal(gstInputLine.gl_account_code, 'GL-INPUT-IGST', 'GST input line carries the GSTIN GL code');
  assert.equal(tdsLine.gl_account_code, 'TDS-194Q', 'TDS payable line carries the section GL code');
  for (const l of je.lines) {
    assert.equal(l.sub_location, 'SL-01');
    assert.equal(l.cost_centre, 'CC-01');
    assert.equal(l.program_product_code, 'PRD-9');
    assert.equal(l.custom_field_1, 'PRJ-42');
  }

  // CSV export carries the new GL columns
  const exportRes = await call('GET', `/api/journal/export?token=${encodeURIComponent(rahul)}`);
  assert.equal(exportRes.status, 200);
  assert.match(exportRes.text, /gl_account_code/);
  assert.match(exportRes.text, /AP-GLTEST/);
});

test('lower-TDS certificate: valid cert suggests its rate and is recorded on the invoice', async () => {
  const priya = await login('priya', 'priya123');
  const rahul = await login('rahul', 'rahul123');

  const vCreate = await call('POST', '/api/vendors', {
    token: priya, body: { name: 'Lower TDS Vendor', pan: 'AABCT7777F', bank_name: 'Test Bank', bank_account: '777', ifsc: 'TEST0000003' },
  });
  const certVendorId = vCreate.json.id;
  for (const docType of ['pan', 'cancelled_cheque']) {
    const form = new FormData();
    form.append('doc_type', docType);
    form.append('file', pdfBlob(), 'doc.pdf');
    await call('POST', `/api/vendors/${certVendorId}/documents`, { token: priya, form });
  }
  await call('POST', `/api/vendors/${certVendorId}/verify`, { token: rahul, body: { ap_account_code: 'AP-LOWERTDS' } });

  // the certificate document itself is mandatory — no file, no certificate
  const noFile = await call('POST', `/api/vendors/${certVendorId}/tds-certificates`, {
    token: rahul,
    form: (() => {
      const fd = new FormData();
      fd.append('tds_section', '194C'); fd.append('certificate_number', 'LDC-000'); fd.append('rate', '1');
      fd.append('valid_from', '2026-01-01'); fd.append('valid_to', '2026-12-31');
      return fd;
    })(),
  });
  assert.equal(noFile.status, 400);
  assert.match(noFile.json.error, /attach the certificate/i);

  const certRes = await call('POST', `/api/vendors/${certVendorId}/tds-certificates`, {
    token: rahul,
    form: (() => {
      const fd = new FormData();
      fd.append('tds_section', '194C'); fd.append('certificate_number', 'LDC-001'); fd.append('rate', '1');
      fd.append('valid_from', '2026-01-01'); fd.append('valid_to', '2026-12-31');
      fd.append('file', pdfBlob(), 'cert.pdf');
      return fd;
    })(),
  });
  assert.equal(certRes.status, 201, certRes.text);
  const certId = certRes.json.id;

  // a second ACTIVE certificate for the same vendor+section may not overlap
  const overlapping = await call('POST', `/api/vendors/${certVendorId}/tds-certificates`, {
    token: rahul,
    form: (() => {
      const fd = new FormData();
      fd.append('tds_section', '194C'); fd.append('certificate_number', 'LDC-002'); fd.append('rate', '0.5');
      fd.append('valid_from', '2026-06-01'); fd.append('valid_to', '2027-05-31');
      fd.append('file', pdfBlob(), 'cert.pdf');
      return fd;
    })(),
  });
  assert.equal(overlapping.status, 400);
  assert.match(overlapping.json.error, /already covers/i);

  // the vendor list flags this vendor as having a currently-usable certificate
  const vendorsAfterCert = await call('GET', '/api/vendors', { token: rahul });
  const certVendorRow = vendorsAfterCert.json.find((v) => v.id === certVendorId);
  assert.equal(certVendorRow.active_tds_certificates, 1);

  const poRes = await call('POST', '/api/pos', {
    token: priya, body: { vendor_id: certVendorId, company_gstin_id: 1, items: [{ description: 'Service', quantity: 1, unit: 'EA', unit_price: 50000 }] },
  });
  const certPoId = poRes.json.id;
  const sneha = await login('sneha', 'sneha123');
  const invRes = await call('POST', '/api/invoices', {
    token: sneha,
    body: { po_id: certPoId, invoice_date: '2026-06-15', subtotal: 50000, cgst_amount: 0, sgst_amount: 0 },
  });
  const certInvoiceId = invRes.json.id;

  // this invoice's chain is also 2 levels — clear level 1 first
  const certL1 = await call('POST', `/api/invoices/${certInvoiceId}/approve`, { token: rahul, body: {} });
  assert.equal(certL1.status, 200, certL1.text);
  assert.equal(certL1.json.finished, false);

  // wrong section/expired-outside-range certificate id is rejected
  const badApprove = await call('POST', `/api/invoices/${certInvoiceId}/approve`, {
    token: rahul, body: { tds_section: '194J', tds_rate: 1, tds_certificate_id: certId, itc_eligibility: 'eligible' },
  });
  assert.equal(badApprove.status, 400);
  assert.match(badApprove.json.error, /not valid/i);

  const approve = await call('POST', `/api/invoices/${certInvoiceId}/approve`, {
    token: rahul, body: { tds_section: '194C', tds_rate: 1, tds_certificate_id: certId, itc_eligibility: 'eligible' },
  });
  assert.equal(approve.status, 200, approve.text);
  assert.equal(approve.json.tdsAmount, 500); // 50000 @ 1%
});

test('lower-TDS certificate: threshold caps cumulative usage, not just the validity window', async () => {
  const priya = await login('priya', 'priya123');
  const rahul = await login('rahul', 'rahul123');

  const vCreate = await call('POST', '/api/vendors', {
    token: priya, body: { name: 'Threshold TDS Vendor', pan: 'AABCT8888F', bank_name: 'Test Bank', bank_account: '888', ifsc: 'TEST0000004' },
  });
  const thVendorId = vCreate.json.id;
  for (const docType of ['pan', 'cancelled_cheque']) {
    const form = new FormData();
    form.append('doc_type', docType);
    form.append('file', pdfBlob(), 'doc.pdf');
    await call('POST', `/api/vendors/${thVendorId}/documents`, { token: priya, form });
  }
  await call('POST', `/api/vendors/${thVendorId}/verify`, { token: rahul, body: { ap_account_code: 'AP-THRESHOLD' } });

  // certificate authorised for a total of ₹60,000 across its validity window
  const certRes = await call('POST', `/api/vendors/${thVendorId}/tds-certificates`, {
    token: rahul,
    form: (() => {
      const fd = new FormData();
      fd.append('tds_section', '194C'); fd.append('certificate_number', 'LDC-TH-001'); fd.append('rate', '1');
      fd.append('threshold_amount', '60000');
      fd.append('valid_from', '2026-01-01'); fd.append('valid_to', '2026-12-31');
      fd.append('file', pdfBlob(), 'cert.pdf');
      return fd;
    })(),
  });
  assert.equal(certRes.status, 201, certRes.text);
  const thCertId = certRes.json.id;

  const raisePo = async (unitPrice) => {
    const po = await call('POST', '/api/pos', {
      token: priya, body: { vendor_id: thVendorId, company_gstin_id: 1, items: [{ description: 'Service', quantity: 1, unit: 'EA', unit_price: unitPrice }] },
    });
    return po.json.id;
  };
  const raiseAndClearL1 = async (poId, subtotal) => {
    const sneha = await login('sneha', 'sneha123');
    const inv = await call('POST', '/api/invoices', { token: sneha, body: { po_id: poId, invoice_date: '2026-06-15', subtotal, cgst_amount: 0, sgst_amount: 0 } });
    const l1 = await call('POST', `/api/invoices/${inv.json.id}/approve`, { token: rahul, body: {} });
    assert.equal(l1.status, 200, l1.text);
    assert.equal(l1.json.finished, false);
    return inv.json.id;
  };

  // first ₹50,000 invoice uses the certificate, leaving ₹10,000 of headroom
  const invA = await raiseAndClearL1(await raisePo(50000), 50000);
  const approveA = await call('POST', `/api/invoices/${invA}/approve`, {
    token: rahul, body: { tds_section: '194C', tds_rate: 1, tds_certificate_id: thCertId, itc_eligibility: 'eligible' },
  });
  assert.equal(approveA.status, 200, approveA.text);
  assert.equal(approveA.json.tdsAmount, 500); // 50000 @ 1%

  // a further ₹20,000 invoice would push cumulative usage to ₹70,000 — over the ₹60,000 threshold
  const invB = await raiseAndClearL1(await raisePo(20000), 20000);
  const overThreshold = await call('POST', `/api/invoices/${invB}/approve`, {
    token: rahul, body: { tds_section: '194C', tds_rate: 1, tds_certificate_id: thCertId, itc_eligibility: 'eligible' },
  });
  assert.equal(overThreshold.status, 400);
  assert.match(overThreshold.json.error, /threshold/i);
  // finance falls back to the standard rate instead
  const standardRate = await call('POST', `/api/invoices/${invB}/approve`, {
    token: rahul, body: { tds_section: '194C', tds_rate: 2, itc_eligibility: 'eligible' },
  });
  assert.equal(standardRate.status, 200, standardRate.text);

  // exactly the remaining ₹10,000 headroom still fits
  const invC = await raiseAndClearL1(await raisePo(10000), 10000);
  const approveC = await call('POST', `/api/invoices/${invC}/approve`, {
    token: rahul, body: { tds_section: '194C', tds_rate: 1, tds_certificate_id: thCertId, itc_eligibility: 'eligible' },
  });
  assert.equal(approveC.status, 200, approveC.text);

  const certsAfter = await call('GET', `/api/vendors/${thVendorId}/tds-certificates`, { token: rahul });
  const thCert = certsAfter.json.find((c) => c.id === thCertId);
  assert.equal(thCert.utilized_amount, 60000);
  assert.equal(thCert.remaining_amount, 0);
  assert.equal(thCert.is_exhausted, true);
  assert.equal(thCert.is_expired, false);

  // an exhausted certificate no longer counts as "usable" on the vendor list
  const vendorsAfterExhaustion = await call('GET', '/api/vendors', { token: rahul });
  const thVendorRow = vendorsAfterExhaustion.json.find((v) => v.id === thVendorId);
  assert.equal(thVendorRow.active_tds_certificates, 0);
});

test('visibility: dept heads/deputies see only their departments; finance sees all; activity feed is own-only', async () => {
  const meera = await login('meera', 'meera123');   // approver — IT head, Facilities deputy
  const rahul = await login('rahul', 'rahul123');   // finance
  const vikram = await login('vikram', 'vikram123'); // requester — IT
  const priya = await login('priya', 'priya123');   // procurement (central function)
  const sneha = await login('sneha', 'sneha123');   // finance clerk

  // invoiceId was entered by sneha (Finance department): meera must not see it
  const meeraList = await call('GET', '/api/invoices', { token: meera });
  assert.equal(meeraList.status, 200);
  assert.ok(!meeraList.json.some((i) => i.id === invoiceId), 'finance-department invoice hidden from IT head');
  const meeraDetail = await call('GET', `/api/invoices/${invoiceId}`, { token: meera });
  assert.equal(meeraDetail.status, 403);
  assert.match(meeraDetail.json.error, /another department/i);

  // finance and procurement see every department's documents
  const rahulList = await call('GET', '/api/invoices', { token: rahul });
  assert.ok(rahulList.json.some((i) => i.id === invoiceId), 'finance sees all invoices');
  const priyaList = await call('GET', '/api/invoices', { token: priya });
  assert.ok(priyaList.json.some((i) => i.id === invoiceId), 'procurement sees all invoices');

  // meera still sees the IT-department PR she approved as head
  const meeraPr = await call('GET', `/api/prs/${smallPrId}`, { token: meera });
  assert.equal(meeraPr.status, 200);

  // vikram (plain requester) sees only IT PRs or his own
  const meVikram = await call('GET', '/api/auth/me', { token: vikram });
  const vikramPrs = await call('GET', '/api/prs', { token: vikram });
  assert.ok(vikramPrs.json.length > 0, 'vikram still sees his own PRs');
  assert.ok(vikramPrs.json.every((p) => p.department_name === 'IT' || p.requester_id === meVikram.json.id),
    'requester list limited to own department');

  // recent activity: vikram sees only his own actions; finance sees everyone's
  const vikramDash = await call('GET', '/api/dashboard', { token: vikram });
  assert.ok(vikramDash.json.recentActivity.every((a) => a.user_id === meVikram.json.id),
    'non-finance activity feed limited to own actions');
  const meRahul = await call('GET', '/api/auth/me', { token: rahul });
  const rahulDash = await call('GET', '/api/dashboard', { token: rahul });
  assert.ok(rahulDash.json.recentActivity.some((a) => a.user_id !== meRahul.json.id),
    'finance activity feed includes other users');

  // attachment downloads follow the same scoping — the file must not leak
  // what the invoice page itself refuses to show
  const attPo = await call('POST', '/api/pos', {
    token: priya, body: { vendor_id: vendorId, company_gstin_id: 1, items: [{ description: 'Svc', quantity: 1, unit: 'EA', unit_price: 900 }] },
  });
  const attForm = new FormData();
  attForm.append('po_id', String(attPo.json.id));
  attForm.append('invoice_date', '2026-07-12');
  attForm.append('subtotal', '900');
  attForm.append('cgst_amount', '0');
  attForm.append('sgst_amount', '0');
  attForm.append('attachment', pdfBlob(), 'inv.pdf');
  const attInv = await call('POST', '/api/invoices', { token: sneha, form: attForm });
  assert.equal(attInv.status, 201, attInv.text);
  const meeraAtt = await call('GET', `/api/invoices/${attInv.json.id}/attachment?token=${encodeURIComponent(meera)}`);
  assert.equal(meeraAtt.status, 403, 'other-department attachment must be refused');
  const rahulAtt = await call('GET', `/api/invoices/${attInv.json.id}/attachment?token=${encodeURIComponent(rahul)}`);
  assert.equal(rahulAtt.status, 200, rahulAtt.text);

  // the payments list inherits invoice visibility: every payment so far settles
  // a Finance-department or department-less invoice, so vikram (IT) sees none
  const vikramPays = await call('GET', '/api/payments', { token: vikram });
  assert.equal(vikramPays.json.length, 0, 'IT requester sees no other-department payments');
  const rahulPays = await call('GET', '/api/payments', { token: rahul });
  assert.ok(rahulPays.json.length > 0, 'finance sees all payments');
});

test('concurrency: parallel submissions get unique numbers; a final approval can only book once', async () => {
  const vikram = await login('vikram', 'vikram123');
  const priya = await login('priya', 'priya123');
  const rahul = await login('rahul', 'rahul123');
  const sneha = await login('sneha', 'sneha123');

  // five PRs raised at the same instant must all succeed with distinct numbers
  const results = await Promise.all([1, 2, 3, 4, 5].map((i) => call('POST', '/api/prs', {
    token: vikram,
    body: { justification: `parallel PR ${i}`, items: [{ description: 'Widget', quantity: 1, unit: 'EA', est_unit_price: 100 }] },
  })));
  for (const r of results) assert.equal(r.status, 201, r.text);
  const numbers = results.map((r) => r.json.pr_number);
  assert.equal(new Set(numbers).size, 5, `PR numbers must be unique, got: ${numbers.join(', ')}`);

  // two simultaneous final approvals of one invoice must book it exactly once
  const po = await call('POST', '/api/pos', {
    token: priya, body: { vendor_id: vendorId, company_gstin_id: 1, items: [{ description: 'Service', quantity: 1, unit: 'EA', unit_price: 1000 }] },
  });
  const inv = await call('POST', '/api/invoices', {
    token: sneha, body: { po_id: po.json.id, invoice_date: '2026-07-01', subtotal: 1000, cgst_amount: 0, sgst_amount: 0 },
  });
  assert.equal(inv.status, 201, inv.text);
  const l1 = await call('POST', `/api/invoices/${inv.json.id}/approve`, { token: rahul, body: {} });
  assert.equal(l1.json.finished, false);
  const [a, b2] = await Promise.all([
    call('POST', `/api/invoices/${inv.json.id}/approve`, { token: rahul, body: {} }),
    call('POST', `/api/invoices/${inv.json.id}/approve`, { token: rahul, body: {} }),
  ]);
  const statuses = [a.status, b2.status].sort();
  assert.deepEqual(statuses, [200, 400], `expected exactly one success, got ${a.status}/${b2.status}`);
  const loser = a.status === 400 ? a : b2;
  assert.match(loser.json.error, /already processed|Cannot approve/i);
  // and exactly one booking JE exists for this invoice
  const journal = await call('GET', '/api/journal', { token: rahul });
  const bookings = journal.json.filter((j) => j.ref_type === 'invoice' && j.ref_id === inv.json.id);
  assert.equal(bookings.length, 1, 'exactly one booking JE');
});

test('AP controls: duplicate invoices blocked, GL period lock, TDS rate discipline', async () => {
  const priya = await login('priya', 'priya123');
  const rahul = await login('rahul', 'rahul123');
  const sneha = await login('sneha', 'sneha123');
  const vikram = await login('vikram', 'vikram123');
  const admin = await login('admin', 'admin123');
  const mkPo = async (vid) => (await call('POST', '/api/pos', {
    token: priya, body: { vendor_id: vid, company_gstin_id: 1, items: [{ description: 'Service', quantity: 1, unit: 'EA', unit_price: 1000 }] },
  })).json.id;
  const mkInv = async (poId, body) => call('POST', '/api/invoices', {
    token: sneha, body: { po_id: poId, invoice_date: '2026-07-10', subtotal: 1000, cgst_amount: 0, sgst_amount: 0, ...body },
  });
  const clearL1 = async (invId) => {
    const l1 = await call('POST', `/api/invoices/${invId}/approve`, { token: rahul, body: {} });
    assert.equal(l1.json.finished, false, l1.text);
  };

  // --- duplicate detection: same vendor + same ref (case/space-insensitive) is blocked
  const dupPo = await mkPo(vendorId);
  const first = await mkInv(dupPo, { vendor_invoice_ref: 'DUP/001' });
  assert.equal(first.status, 201, first.text);
  const dup = await mkInv(dupPo, { vendor_invoice_ref: 'dup / 001' });
  assert.equal(dup.status, 400);
  assert.match(dup.json.error, /duplicate/i);
  // the same reference for a DIFFERENT vendor is fine
  const otherVendorPo = await mkPo(1);
  const otherVendor = await mkInv(otherVendorPo, { vendor_invoice_ref: 'DUP/001', hsn_sac_code: '998314' });
  assert.equal(otherVendor.status, 201, otherVendor.text);

  // --- gl_period format is validated at final approval
  const fmtPo = await mkPo(vendorId);
  const fmtInv = (await mkInv(fmtPo, {})).json.id;
  await clearL1(fmtInv);
  const badPeriod = await call('POST', `/api/invoices/${fmtInv}/approve`, { token: rahul, body: { gl_period: 'July-26' } });
  assert.equal(badPeriod.status, 400);
  assert.match(badPeriod.json.error, /YYYY-MM/);

  // --- GL period lock: only finance/admin may set it; posting into a closed month is refused
  const notFinance = await call('PUT', '/api/settings/gl-lock', { token: vikram, body: { locked_through: '2026-07' } });
  assert.equal(notFinance.status, 403);
  const setLock = await call('PUT', '/api/settings/gl-lock', { token: rahul, body: { locked_through: '2026-07' } });
  assert.equal(setLock.status, 200, setLock.text);
  const intoLocked = await call('POST', `/api/invoices/${fmtInv}/approve`, { token: rahul, body: { gl_period: '2026-07' } });
  assert.equal(intoLocked.status, 400);
  assert.match(intoLocked.json.error, /closed|locked/i);
  // a later, open period posts fine
  const intoOpen = await call('POST', `/api/invoices/${fmtInv}/approve`, { token: rahul, body: { gl_period: '2026-08' } });
  assert.equal(intoOpen.status, 200, intoOpen.text);
  // payments respect the lock too: releasing into the closed month is refused
  const pay = await call('POST', '/api/payments', { token: rahul, body: { invoice_id: fmtInv, amount: 500, payment_date: '2026-07-15' } });
  assert.equal(pay.status, 201, pay.text);
  const lockedRelease = await call('POST', `/api/payments/${pay.json.id}/release`, { token: admin, body: {} });
  assert.equal(lockedRelease.status, 400);
  assert.match(lockedRelease.json.error, /closed|locked/i);
  const clearLock = await call('PUT', '/api/settings/gl-lock', { token: rahul, body: { locked_through: '' } });
  assert.equal(clearLock.status, 200, clearLock.text);
  const reopenedRelease = await call('POST', `/api/payments/${pay.json.id}/release`, { token: admin, body: {} });
  assert.equal(reopenedRelease.status, 200, reopenedRelease.text);

  // --- TDS rate discipline: deviation from the section master needs an explicit reason
  const ratePo = await mkPo(vendorId);
  const rateInv = (await mkInv(ratePo, {})).json.id;
  await clearL1(rateInv);
  const oddRate = await call('POST', `/api/invoices/${rateInv}/approve`, {
    token: rahul, body: { tds_section: '194C', tds_rate: 5, itc_eligibility: 'eligible' },
  });
  assert.equal(oddRate.status, 400);
  assert.match(oddRate.json.error, /override reason/i);
  const withReason = await call('POST', `/api/invoices/${rateInv}/approve`, {
    token: rahul, body: { tds_section: '194C', tds_rate: 5, itc_eligibility: 'eligible', tds_rate_override_reason: 'AO order 123/2026' },
  });
  assert.equal(withReason.status, 200, withReason.text);
  assert.equal(withReason.json.tdsAmount, 50); // 1000 @ 5%
});
