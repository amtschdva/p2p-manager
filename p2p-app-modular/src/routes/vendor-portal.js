// Module "vendor_portal": supplier self-service — registration, profile & KYC
// uploads, PO visibility and invoice submission. Mounted by the combined
// server (default) or by src/vendor-server.js when the portal runs as its own
// container.
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { db, audit, nextNumber } = require('../db');
const modules = require('../modules');
const { JWT_SECRET, TOKEN_TTL, loginLimiter, registerLimiter, requireVendorAuth, wrap,
        checkPassword, upload, UPLOAD_DIR, verifyFileSignature } = require('../context');
const { computeMatch, prepareInvoiceTax, prepareReceiptAndDueDate, prepareInvoiceGlFields, GST_STATES } = require('../lib/queries');
const { vendorDocUpload, saveVendorDocument, vendorDocsFor } = require('../lib/vendor-docs');
const approvals = require('../approvals');
const { sendMail, usersByRole } = require('../mailer');

// POs visible to the vendor (only ones actually sent to them)
const VENDOR_PO_STATUSES = ['sent', 'partially_received', 'received', 'closed'];

module.exports = function register(app) {
  // public self-registration: creates an unverified vendor + a portal login
  app.post('/api/vendor/register', registerLimiter, wrap(async (req, res) => {
    const b = req.body || {};
    const required = { company_name: 'Company name', contact_person: 'Contact person', email: 'Email', password: 'Password' };
    for (const [k, label] of Object.entries(required)) {
      if (!b[k] || !String(b[k]).trim()) throw new Error(`${label} is required`);
    }
    checkPassword(b.password);
    const email = String(b.email).trim().toLowerCase();
    if (await db.prepare('SELECT id FROM vendor_users WHERE email = ?').get(email)) {
      throw new Error('An account with this email already exists');
    }
    const last = await db.prepare('SELECT code FROM vendors ORDER BY id DESC LIMIT 1').get();
    let seq = 1;
    if (last) { const m = last.code.match(/(\d+)$/); if (m) seq = parseInt(m[1], 10) + 1; }
    const result = await db.tx(async () => {
      const vendorId = (await db.prepare(`INSERT INTO vendors
        (code, name, contact_person, email, phone, address, gstin, pan, bank_name, bank_account, ifsc, payment_terms, status, verified)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'inactive',0)`)
        .run(`V-${String(seq).padStart(4, '0')}`, b.company_name.trim(), b.contact_person.trim(), email,
             b.phone || null, b.address || null, b.gstin || null, b.pan || null,
             b.bank_name || null, b.bank_account || null, b.ifsc || null, b.payment_terms || 'Net 30')).lastInsertRowid;
      const userId = (await db.prepare('INSERT INTO vendor_users (vendor_id, email, password_hash, full_name) VALUES (?,?,?,?)')
        .run(vendorId, email, bcrypt.hashSync(b.password, 10), b.contact_person.trim())).lastInsertRowid;
      return { vendorId, userId };
    });
    audit(null, 'self_register', 'vendor', result.vendorId, b.company_name.trim());
    sendMail(usersByRole('finance', 'admin'),
      `[P2P] New vendor registration awaiting verification — ${b.company_name.trim()}`,
      [`<strong>${b.company_name.trim()}</strong> (${b.contact_person.trim()}, ${email}) registered on the vendor portal.`,
       'Review their details and KYC documents on the Vendors page, then verify or reject.'],
      '#/vendors');
    const token = jwt.sign({ sub: result.userId, kind: 'vendor' }, JWT_SECRET, { expiresIn: TOKEN_TTL });
    res.status(201).json({ token, message: 'Registration received — your account is pending verification by our procurement team' });
  }));

  app.post('/api/vendor/login', loginLimiter, wrap(async (req, res) => {
    const { email, password } = req.body || {};
    const vu = await db.prepare('SELECT * FROM vendor_users WHERE email = ?').get((email || '').trim().toLowerCase());
    if (!vu || !bcrypt.compareSync(password || '', vu.password_hash)) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    if (!vu.active) return res.status(401).json({ error: 'Account is deactivated' });
    const token = jwt.sign({ sub: vu.id, kind: 'vendor' }, JWT_SECRET, { expiresIn: TOKEN_TTL });
    res.json({ token });
  }));

  app.get('/api/vendor/me', requireVendorAuth, wrap(async (req, res) => {
    const vendor = await db.prepare('SELECT * FROM vendors WHERE id = ?').get(req.vendorUser.vendor_id);
    res.json({
      user: { email: req.vendorUser.email, full_name: req.vendorUser.full_name },
      vendor, modules: modules.ENABLED, gst_states: modules.enabled('tax') ? GST_STATES : [],
    });
  }));

  // vendor changes their own portal password (e.g. after a staff reset)
  app.post('/api/vendor/change-password', requireVendorAuth, wrap(async (req, res) => {
    const { current_password, new_password } = req.body || {};
    checkPassword(new_password);
    const vu = await db.prepare('SELECT * FROM vendor_users WHERE id = ?').get(req.vendorUser.id);
    if (!bcrypt.compareSync(current_password || '', vu.password_hash)) throw new Error('Current password is incorrect');
    await db.prepare('UPDATE vendor_users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(new_password, 10), vu.id);
    audit(null, 'portal_change_password', 'vendor', req.vendorUser.vendor_id, req.vendorUser.email);
    res.json({ ok: true });
  }));

  // vendor may keep their own contact/bank details current; identity & verification fields stay locked
  app.put('/api/vendor/profile', requireVendorAuth, wrap(async (req, res) => {
    const v = await db.prepare('SELECT * FROM vendors WHERE id = ?').get(req.vendorUser.vendor_id);
    const b = { ...v, ...req.body };
    await db.prepare(`UPDATE vendors SET contact_person=?, phone=?, address=?, gstin=?, pan=?, bank_name=?, bank_account=?, ifsc=? WHERE id=?`)
      .run(b.contact_person, b.phone, b.address, b.gstin, b.pan, b.bank_name, b.bank_account, b.ifsc, v.id);
    audit(null, 'portal_profile_update', 'vendor', v.id, v.name);
    res.json({ ok: true });
  }));

  // vendor's own KYC documents (list + upload from the portal)
  app.get('/api/vendor/documents', requireVendorAuth, wrap(async (req, res) => {
    res.json(await vendorDocsFor(req.vendorUser.vendor_id));
  }));

  app.post('/api/vendor/documents', requireVendorAuth, async (req, res) => {
    vendorDocUpload.single('file')(req, res, async (err) => {
      try {
        if (err) throw err;
        if (!req.file) throw new Error('Attach the document file');
        await saveVendorDocument(req.vendorUser.vendor_id, req.body.doc_type, req.file, null, req.vendorUser.id);
        audit(null, 'portal_upload_doc', 'vendor', req.vendorUser.vendor_id, `${req.body.doc_type} by ${req.vendorUser.full_name}`);
        res.status(201).json({ ok: true });
      } catch (e) {
        res.status(400).json({ error: e.message || 'Upload failed' });
      }
    });
  });

  app.get('/api/vendor/pos', requireVendorAuth, wrap(async (req, res) => {
    const pos = await db.prepare(`
      SELECT po.id, po.po_number, po.status, po.expected_date, po.notes, po.created_at,
        cg.gstin AS company_gstin, cg.state_code AS company_state_code, cg.label AS gstin_label,
        (SELECT COALESCE(SUM(quantity * unit_price), 0) FROM po_items WHERE po_id = po.id) AS total
      FROM pos po LEFT JOIN company_gstins cg ON cg.id = po.company_gstin_id
      WHERE po.vendor_id = ? AND po.status IN (${VENDOR_PO_STATUSES.map(() => '?').join(',')})
      ORDER BY po.id DESC`).all(req.vendorUser.vendor_id, ...VENDOR_PO_STATUSES);
    for (const po of pos) {
      po.items = await db.prepare(`
        SELECT pi.description, pi.quantity, pi.unit, pi.unit_price,
          COALESCE((SELECT SUM(gi.quantity_received) FROM grn_items gi JOIN grns g ON g.id = gi.grn_id
                    WHERE gi.po_item_id = pi.id AND g.status = 'approved'), 0) AS received_qty
        FROM po_items pi WHERE pi.po_id = ?`).all(po.id);
    }
    res.json(pos);
  }));

  app.get('/api/vendor/invoices', requireVendorAuth, wrap(async (req, res) => {
    const invoices = await db.prepare(`
      SELECT i.id, i.invoice_number, i.vendor_invoice_ref, i.invoice_date, i.received_date, i.due_date, i.subtotal,
        i.place_of_supply_code, i.place_of_supply_state, i.hsn_sac_code, i.gl_description,
        i.cgst_amount, i.sgst_amount, i.igst_amount, i.tax_amount, i.total, i.rcm,
        i.tds_section, i.tds_rate, i.tds_amount,
        i.status, i.match_status, i.match_notes, i.source, i.attachment_name, i.created_at, po.po_number,
        COALESCE((SELECT SUM(amount) FROM payments WHERE invoice_id = i.id AND status = 'released'), 0) AS paid_amount
      FROM invoices i JOIN pos po ON po.id = i.po_id
      WHERE i.vendor_id = ? ORDER BY i.id DESC`).all(req.vendorUser.vendor_id);
    for (const inv of invoices) {
      inv.payments = await db.prepare(`SELECT payment_number, amount, payment_date, method, reference FROM payments WHERE invoice_id = ? AND status = 'released'`).all(inv.id);
    }
    res.json(invoices);
  }));

  // vendor submits an invoice against one of their POs, optionally with a PDF/image attachment
  app.post('/api/vendor/invoices', requireVendorAuth, async (req, res) => {
    upload.single('attachment')(req, res, async (uploadErr) => {
      try {
        if (uploadErr) throw uploadErr;
        if (req.file && !verifyFileSignature(path.join(UPLOAD_DIR, req.file.filename), req.file.originalname)) {
          throw new Error('The uploaded file does not look like a valid PDF, PNG or JPG');
        }
        if (!req.vendorUser.verified || req.vendorUser.vendor_status !== 'active') {
          throw new Error('Your vendor account is not verified yet — invoices can be submitted once our team approves your registration');
        }
        const b = req.body || {};
        const po = await db.prepare('SELECT * FROM pos WHERE id = ?').get(Number(b.po_id));
        if (!po || po.vendor_id !== req.vendorUser.vendor_id) throw new Error('PO not found');
        if (!VENDOR_PO_STATUSES.includes(po.status) || po.status === 'closed') {
          throw new Error(`Invoices cannot be submitted against a ${po.status} PO`);
        }
        if (!b.invoice_date) throw new Error('Invoice date is required');
        const modules = require('../modules');
        if (modules.enabled('tax') && !po.company_gstin_id) {
          throw new Error('This PO has no GST registration assigned — contact the buyer');
        }
        const vendor = await db.prepare('SELECT * FROM vendors WHERE id = ?').get(po.vendor_id);
        const t = await prepareInvoiceTax(po, vendor, b);
        const { receivedDate, dueDate } = prepareReceiptAndDueDate(vendor, b);
        const gl = await prepareInvoiceGlFields(vendor, b);

        const match = await computeMatch(po.id, t.sub);
        const invNumber = await nextNumber('INV', 'invoices', 'invoice_number');
        const id = (await db.prepare(`INSERT INTO invoices
          (invoice_number, vendor_invoice_ref, po_id, vendor_id, company_gstin_id, invoice_date, received_date, due_date,
           place_of_supply_code, place_of_supply_state, hsn_sac_code, gl_description,
           subtotal, cgst_amount, sgst_amount, igst_amount, tax_amount, total,
           rcm, rcm_category_id, currency, gstr2b_status,
           status, match_status, match_notes, source, vendor_user_id, attachment_path, attachment_name)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',?,?,'vendor',?,?,?)`)
          .run(invNumber, b.vendor_invoice_ref || null, po.id, po.vendor_id, po.company_gstin_id, b.invoice_date, receivedDate, dueDate,
               gl.placeOfSupplyCode, gl.placeOfSupplyState, gl.hsnSacCode, gl.glDescription,
               t.sub, t.cgst, t.sgst, t.igst, t.tax, t.total,
               t.rcm, t.rcmCategoryId, vendor.currency || 'INR', t.gstr2bStatus,
               match.status, match.notes, req.vendorUser.id,
               req.file ? req.file.filename : null, req.file ? req.file.originalname : null)).lastInsertRowid;
        const invDeptId = ((await db.prepare('SELECT department_id FROM users WHERE id = ?').get(po.created_by)) || {}).department_id || null;
        if (invDeptId) await db.prepare('UPDATE invoices SET department_id = ? WHERE id = ?').run(invDeptId, id);
        await approvals.createApprovals('invoice', id, invDeptId, t.total);
        audit(null, 'portal_submit', 'invoice', id, `${invNumber} by ${req.vendorUser.vendor_name}`);
        res.status(201).json({ id, invoice_number: invNumber, match_status: match.status });
      } catch (e) {
        if (req.file) fs.unlink(path.join(UPLOAD_DIR, req.file.filename), () => {});
        res.status(400).json({ error: e.message || 'Request failed' });
      }
    });
  });

  // vendor portal page
  app.get('/vendor', (req, res) => {
    res.sendFile(path.join(__dirname, '..', '..', 'public', 'vendor.html'));
  });
};
