// Core: vendor (AP) master data, KYC documents, finance verification.
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const { db, audit, DATA_DIR } = require('../db');
const modules = require('../modules');
const { JWT_SECRET, requireAuth, requireRole, wrap, bearerToken, checkPassword } = require('../context');
const { VENDOR_DOCS_DIR, requiredVendorDocs, vendorDocUpload, saveVendorDocument, vendorDocsFor } = require('../lib/vendor-docs');
const { sendMail, vendorEmails } = require('../mailer');

// Lower/nil-TDS deduction certificates live in their own upload directory,
// same PDF/PNG/JPG-only pattern as vendor KYC documents.
const TDS_CERT_DIR = path.join(DATA_DIR, 'vendor-tds-certs');
fs.mkdirSync(TDS_CERT_DIR, { recursive: true });
const tdsCertUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = ['.pdf', '.png', '.jpg', '.jpeg'].includes(path.extname(file.originalname).toLowerCase());
    cb(ok ? null : new Error('Certificate must be PDF, PNG or JPG up to 5 MB'), ok);
  },
});

module.exports = function register(app) {
  app.get('/api/vendors', requireAuth, async (req, res) => {
    const vendors = await db.prepare('SELECT * FROM vendors ORDER BY name').all();
    const docTypes = await db.prepare('SELECT vendor_id, doc_type FROM vendor_documents').all();
    // a certificate is actually usable right now only if it's active, within its
    // validity window, and (when it has one) hasn't hit its threshold yet
    const today = new Date().toISOString().slice(0, 10);
    const allCerts = await db.prepare(`SELECT c.vendor_id, c.active, c.valid_from, c.valid_to, c.threshold_amount,
        COALESCE((SELECT SUM(i.subtotal) FROM invoices i WHERE i.tds_certificate_id = c.id AND i.status NOT IN ('rejected', 'cancelled')), 0) AS utilized_amount
      FROM vendor_tds_certificates c`).all();
    for (const v of vendors) {
      v.documents = docTypes.filter((d) => d.vendor_id === v.id).map((d) => d.doc_type);
      v.active_tds_certificates = allCerts.filter((c) => c.vendor_id === v.id && c.active
        && c.valid_from <= today && c.valid_to >= today
        && (c.threshold_amount == null || c.utilized_amount < c.threshold_amount)).length;
    }
    res.json(vendors);
  });

  // any staff member can propose a vendor; it starts unverified/inactive and
  // goes to the finance verification queue with its KYC documents
  // every vendor's AP account code is its own dedicated GL control account —
  // two vendors must never share one, so a code is unique across the vendor
  // master the moment it's assigned (excludeVendorId lets an update keep its own)
  async function assertApAccountCodeAvailable(code, excludeVendorId) {
    if (!code) return;
    const clash = await db.prepare('SELECT name FROM vendors WHERE ap_account_code = ? AND id != ?')
      .get(code, excludeVendorId || 0);
    if (clash) throw new Error(`AP account code "${code}" is already assigned to vendor "${clash.name}" — each vendor needs its own unique code`);
  }

  app.post('/api/vendors', requireAuth, wrap(async (req, res) => {
    const v = req.body;
    if (!v.name) throw new Error('Vendor name is required');
    const last = await db.prepare('SELECT code FROM vendors ORDER BY id DESC LIMIT 1').get();
    let seq = 1;
    if (last) { const m = last.code.match(/(\d+)$/); if (m) seq = parseInt(m[1], 10) + 1; }
    const finalCode = v.code || `V-${String(seq).padStart(4, '0')}`;
    const paymentTermsDays = Number(v.payment_terms_days) || 30;
    const apAccountCode = (v.ap_account_code || '').trim() || null;
    await assertApAccountCodeAvailable(apAccountCode);
    const id = (await db.prepare(`INSERT INTO vendors
      (code, name, vendor_type, contact_person, email, phone, address, gstin, pan, tax_category, bank_name, bank_account, ifsc,
       payment_terms, payment_terms_days, ap_account_code, currency, status, verified)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'inactive',0)`)
      .run(finalCode, v.name, v.vendor_type === 'overseas' ? 'overseas' : 'domestic', v.contact_person || null, v.email || null, v.phone || null, v.address || null,
           v.gstin || null, v.pan || null, v.tax_category || 'registered', v.bank_name || null, v.bank_account || null,
           v.ifsc || null, `Net ${paymentTermsDays}`, paymentTermsDays, apAccountCode, v.currency || 'INR')).lastInsertRowid;
    audit(req.user.id, 'create', 'vendor', id, `${v.name} (pending verification)`);
    res.status(201).json({ id, message: 'Vendor created — upload the KYC documents so finance can verify it' });
  }));

  // KYC documents: list, upload (any staff), download (staff or the owning vendor)
  app.get('/api/vendors/:id/documents', requireAuth, wrap(async (req, res) => {
    if (!await db.prepare('SELECT id FROM vendors WHERE id = ?').get(req.params.id)) return res.status(404).json({ error: 'Vendor not found' });
    res.json(await vendorDocsFor(Number(req.params.id)));
  }));

  app.post('/api/vendors/:id/documents', requireAuth, async (req, res) => {
    vendorDocUpload.single('file')(req, res, async (err) => {
      try {
        if (err) throw err;
        if (!req.file) throw new Error('Attach the document file');
        const vendor = await db.prepare('SELECT * FROM vendors WHERE id = ?').get(req.params.id);
        if (!vendor) return res.status(404).json({ error: 'Vendor not found' });
        await saveVendorDocument(vendor.id, req.body.doc_type, req.file, req.user.id, null);
        audit(req.user.id, 'upload_doc', 'vendor', vendor.id, `${req.body.doc_type} for ${vendor.name}`);
        res.status(201).json({ ok: true });
      } catch (e) {
        res.status(400).json({ error: e.message || 'Upload failed' });
      }
    });
  });

  app.get('/api/vendors/:id/documents/:docId/file', wrap(async (req, res) => {
    const token = bearerToken(req) || req.query.token;
    let payload;
    try { payload = jwt.verify(token || '', JWT_SECRET); }
    catch { return res.status(401).json({ error: 'Authentication required' }); }
    const doc = await db.prepare('SELECT * FROM vendor_documents WHERE id = ? AND vendor_id = ?').get(req.params.docId, req.params.id);
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    if (payload.kind === 'vendor') {
      const vu = await db.prepare('SELECT * FROM vendor_users WHERE id = ?').get(payload.sub);
      if (!vu || vu.vendor_id !== doc.vendor_id) return res.status(403).json({ error: 'Not your document' });
    } else if (payload.kind !== 'staff') {
      return res.status(403).json({ error: 'Not an authenticated session' });
    }
    const file = path.join(VENDOR_DOCS_DIR, doc.file_path);
    if (!fs.existsSync(file)) return res.status(404).json({ error: 'File missing on server' });
    res.download(file, doc.file_name);
  }));

  app.put('/api/vendors/:id', requireAuth, requireRole('procurement', 'finance'), wrap(async (req, res) => {
    const id = Number(req.params.id);
    const existing = await db.prepare('SELECT * FROM vendors WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ error: 'Vendor not found' });
    const v = { ...existing, ...req.body };
    const paymentTermsDays = req.body.payment_terms_days !== undefined ? (Number(req.body.payment_terms_days) || 30) : existing.payment_terms_days;
    const apAccountCode = req.body.ap_account_code !== undefined ? ((req.body.ap_account_code || '').trim() || null) : existing.ap_account_code;
    await assertApAccountCodeAvailable(apAccountCode, id);
    await db.prepare(`UPDATE vendors SET name=?, vendor_type=?, contact_person=?, email=?, phone=?, address=?, gstin=?, pan=?, tax_category=?,
      bank_name=?, bank_account=?, ifsc=?, payment_terms=?, payment_terms_days=?, ap_account_code=?, currency=?, status=? WHERE id=?`)
      .run(v.name, v.vendor_type === 'overseas' ? 'overseas' : 'domestic', v.contact_person, v.email, v.phone, v.address, v.gstin, v.pan, v.tax_category,
           v.bank_name, v.bank_account, v.ifsc, `Net ${paymentTermsDays}`, paymentTermsDays,
           apAccountCode, v.currency, v.status, id);
    audit(req.user.id, 'update', 'vendor', id, v.name);
    res.json({ ok: true });
  }));

  // ---------- lower/nil TDS deduction certificates (tax module) ----------
  // A certificate's lower rate applies only up to its threshold_amount (the
  // certificate's authorised limit, if any) — once invoices booked against it
  // reach that limit, or its validity window closes, whichever is sooner, the
  // standard section rate applies again.
  app.get('/api/vendors/:id/tds-certificates', requireAuth, wrap(async (req, res) => {
    if (!modules.enabled('tax')) return res.status(404).json({ error: 'The tax module is not enabled on this installation' });
    if (!await db.prepare('SELECT id FROM vendors WHERE id = ?').get(req.params.id)) return res.status(404).json({ error: 'Vendor not found' });
    const certs = await db.prepare('SELECT * FROM vendor_tds_certificates WHERE vendor_id = ? ORDER BY valid_from DESC').all(req.params.id);
    const today = new Date().toISOString().slice(0, 10);
    for (const c of certs) {
      c.utilized_amount = (await db.prepare(`SELECT COALESCE(SUM(subtotal), 0) AS s FROM invoices
        WHERE tds_certificate_id = ? AND status NOT IN ('rejected', 'cancelled')`).get(c.id)).s;
      c.remaining_amount = c.threshold_amount != null ? Math.max(0, c.threshold_amount - c.utilized_amount) : null;
      // explicit flags so the UI can show *why* a certificate no longer applies —
      // by date, by threshold, or because finance switched it off manually
      c.is_expired = c.valid_to < today;
      c.is_not_yet_valid = c.valid_from > today;
      c.is_exhausted = c.threshold_amount != null && c.remaining_amount <= 0;
    }
    res.json(certs);
  }));

  app.post('/api/vendors/:id/tds-certificates', requireAuth, requireRole('finance'), async (req, res) => {
    if (!modules.enabled('tax')) return res.status(404).json({ error: 'The tax module is not enabled on this installation' });
    tdsCertUpload.single('file')(req, res, async (err) => {
      try {
        if (err) throw err;
        const vendor = await db.prepare('SELECT * FROM vendors WHERE id = ?').get(req.params.id);
        if (!vendor) return res.status(404).json({ error: 'Vendor not found' });
        const b = req.body || {};
        if (!b.tds_section || !b.tds_section.trim()) throw new Error('TDS section is required');
        if (!b.certificate_number || !b.certificate_number.trim()) throw new Error('Certificate number is required');
        const rate = Number(b.rate);
        if (!(rate >= 0 && rate <= 40)) throw new Error('Rate must be between 0 and 40%');
        if (!b.valid_from || !b.valid_to) throw new Error('Valid-from and valid-to dates are required');
        if (b.valid_to < b.valid_from) throw new Error('Valid-to date must be on or after valid-from');
        const thresholdAmount = b.threshold_amount !== undefined && b.threshold_amount !== '' ? Number(b.threshold_amount) : null;
        if (thresholdAmount !== null && !(thresholdAmount > 0)) throw new Error('Threshold amount must be greater than zero');
        let filePath = null, fileName = null;
        if (req.file) {
          const head = req.file.buffer.subarray(0, 8);
          const isPdf = head.subarray(0, 4).equals(Buffer.from('%PDF'));
          const isPng = head.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
          const isJpg = head.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]));
          if (!isPdf && !isPng && !isJpg) throw new Error('The file does not look like a valid PDF, PNG or JPG');
          const dir = path.join(TDS_CERT_DIR, String(vendor.id));
          fs.mkdirSync(dir, { recursive: true });
          const filename = `cert-${Date.now()}${isPdf ? '.pdf' : isPng ? '.png' : '.jpg'}`;
          fs.writeFileSync(path.join(dir, filename), req.file.buffer);
          filePath = `${vendor.id}/${filename}`;
          fileName = req.file.originalname;
        }
        const id = (await db.prepare(`INSERT INTO vendor_tds_certificates
          (vendor_id, tds_section, certificate_number, rate, threshold_amount, valid_from, valid_to, file_path, file_name, uploaded_by)
          VALUES (?,?,?,?,?,?,?,?,?,?)`)
          .run(vendor.id, b.tds_section.trim(), b.certificate_number.trim(), rate, thresholdAmount, b.valid_from, b.valid_to, filePath, fileName, req.user.id)).lastInsertRowid;
        audit(req.user.id, 'create', 'vendor_tds_certificate', id, `${vendor.name} u/s ${b.tds_section.trim()} @ ${rate}%`);
        res.status(201).json({ id });
      } catch (e) {
        res.status(400).json({ error: e.message || 'Request failed' });
      }
    });
  });

  app.put('/api/vendors/:vendorId/tds-certificates/:id', requireAuth, requireRole('finance'), wrap(async (req, res) => {
    if (!modules.enabled('tax')) return res.status(404).json({ error: 'The tax module is not enabled on this installation' });
    const cert = await db.prepare('SELECT * FROM vendor_tds_certificates WHERE id = ? AND vendor_id = ?').get(req.params.id, req.params.vendorId);
    if (!cert) return res.status(404).json({ error: 'Certificate not found' });
    await db.prepare('UPDATE vendor_tds_certificates SET active = ? WHERE id = ?')
      .run(req.body.active !== undefined ? (req.body.active ? 1 : 0) : cert.active, cert.id);
    audit(req.user.id, 'update', 'vendor_tds_certificate', cert.id, cert.certificate_number);
    res.json({ ok: true });
  }));

  app.get('/api/vendors/:id/tds-certificates/:certId/file', wrap(async (req, res) => {
    const token = bearerToken(req) || req.query.token;
    let payload;
    try { payload = jwt.verify(token || '', JWT_SECRET); }
    catch { return res.status(401).json({ error: 'Authentication required' }); }
    if (payload.kind !== 'staff') return res.status(403).json({ error: 'Not a staff session' });
    const cert = await db.prepare('SELECT * FROM vendor_tds_certificates WHERE id = ? AND vendor_id = ?').get(req.params.certId, req.params.id);
    if (!cert || !cert.file_path) return res.status(404).json({ error: 'File not found' });
    const file = path.join(TDS_CERT_DIR, cert.file_path);
    if (!fs.existsSync(file)) return res.status(404).json({ error: 'File missing on server' });
    res.download(file, cert.file_name || 'tds-certificate');
  }));

  // verify a self-registered vendor (activates it for POs and portal invoicing)
  // finance verifies the vendor after checking master data against the KYC documents.
  app.post('/api/vendors/:id/verify', requireAuth, requireRole('finance'), wrap(async (req, res) => {
    const v = await db.prepare('SELECT * FROM vendors WHERE id = ?').get(req.params.id);
    if (!v) return res.status(404).json({ error: 'Vendor not found' });
    if (v.verified) throw new Error('Vendor is already verified');
    if (v.vendor_type !== 'overseas') {
      const have = (await db.prepare('SELECT doc_type FROM vendor_documents WHERE vendor_id = ?').all(v.id)).map((d) => d.doc_type);
      const missing = requiredVendorDocs(v).filter((t) => !have.includes(t));
      if (missing.length) {
        throw new Error(`Cannot verify — missing documents: ${missing.map((m) => m.replace(/_/g, ' ')).join(', ')}`);
      }
      if (!v.pan) throw new Error('Cannot verify — PAN must be filled in on the vendor record');
    }
    // every vendor is its own GL control account, so activation is where finance
    // commits to one — required now unless it was already set on the record
    const apAccountCode = (req.body.ap_account_code || '').trim() || v.ap_account_code || null;
    if (!apAccountCode) throw new Error('Cannot verify — assign an AP account code for this vendor');
    await assertApAccountCodeAvailable(apAccountCode, v.id);
    await db.prepare(`UPDATE vendors SET verified = 1, status = 'active', ap_account_code = ? WHERE id = ?`).run(apAccountCode, v.id);
    audit(req.user.id, 'verify', 'vendor', v.id, v.name);
    sendMail(vendorEmails(v.id),
      `Your vendor registration is approved — ${v.name}`,
      [`Your registration with us has been <strong>verified and activated</strong>. You can now receive purchase orders and submit invoices through the vendor portal.`],
      '/vendor');
    res.json({ ok: true });
  }));

  app.post('/api/vendors/:id/reject-verification', requireAuth, requireRole('finance'), wrap(async (req, res) => {
    const v = await db.prepare('SELECT * FROM vendors WHERE id = ?').get(req.params.id);
    if (!v) return res.status(404).json({ error: 'Vendor not found' });
    if (v.verified) throw new Error('Vendor is already verified');
    await db.prepare(`UPDATE vendors SET status = 'blocked' WHERE id = ?`).run(v.id);
    audit(req.user.id, 'reject_verification', 'vendor', v.id, req.body.reason || v.name);
    sendMail(vendorEmails(v.id),
      `Your vendor registration was not approved — ${v.name}`,
      [`Unfortunately your registration could not be verified.`,
       req.body.reason ? `Reason: ${req.body.reason}` : 'Please contact the procurement team for details.'],
      '/vendor');
    res.json({ ok: true });
  }));

  // vendor forgot their portal password: finance (or admin) sets a new one and
  // shares it out-of-band; the vendor should change it afterwards from
  // Company Profile → Portal password. The new password must meet the standard
  // policy; when a vendor has several portal logins, `email` selects one.
  app.post('/api/vendors/:id/portal-password', requireAuth, requireRole('finance'), wrap(async (req, res) => {
    const v = await db.prepare('SELECT * FROM vendors WHERE id = ?').get(req.params.id);
    if (!v) return res.status(404).json({ error: 'Vendor not found' });
    const { email, new_password } = req.body || {};
    checkPassword(new_password);
    const logins = await db.prepare('SELECT * FROM vendor_users WHERE vendor_id = ? AND active = 1').all(v.id);
    if (!logins.length) throw new Error('This vendor has no portal login — their invoices are entered by staff');
    let target = logins[0];
    if (logins.length > 1) {
      target = logins.find((u) => u.email === String(email || '').trim().toLowerCase());
      if (!target) throw new Error(`This vendor has multiple portal logins — specify the email: ${logins.map((u) => u.email).join(', ')}`);
    }
    await db.prepare('UPDATE vendor_users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(new_password, 10), target.id);
    audit(req.user.id, 'portal_password_reset', 'vendor', v.id, `${v.name} (${target.email})`);
    sendMail([target.email],
      `Your vendor portal password was reset — ${v.name}`,
      [`A member of our team reset the portal password for <strong>${target.email}</strong>.`,
       'If you did not request this, contact the procurement team immediately.',
       'After signing in, please change the password from Company Profile.'],
      '/vendor');
    res.json({ ok: true, email: target.email });
  }));
};
