// Core: vendor invoices with 3-way matching and matrix-driven approval.
// With the tax module enabled, the final approval level selects TDS and posts
// the booking journal entry; without it, approval simply books the invoice.
const path = require('path');
const fs = require('fs');
const jwt = require('jsonwebtoken');
const { db, audit, nextNumber } = require('../db');
const modules = require('../modules');
const approvals = require('../approvals');
const { postInvoiceBookingJE, r2 } = require('../journal');
const { JWT_SECRET, requireAuth, wrap, fmtInr, upload, UPLOAD_DIR, verifyFileSignature, bearerToken } = require('../context');
const { INV_LIST_SQL, computeMatch, prepareInvoiceTax, prepareReceiptAndDueDate, prepareInvoiceGlFields, visibleDeptIds, canSeeDoc, assertNotDuplicateInvoice } = require('../lib/queries');
const { sendMail, userEmail, stepEmails, vendorEmails } = require('../mailer');

// Department scoping plus one principled exception: whoever the matrix has
// assigned to the CURRENT pending step may always view the document —
// otherwise a role-routed approver from another department could be asked
// to approve something they cannot open.
async function canViewInvoice(user, inv) {
  const deptIds = await visibleDeptIds(user);
  if (canSeeDoc(deptIds, inv, user.id, 'created_by')) return true;
  if (inv.status === 'pending') {
    const step = await approvals.currentStep('invoice', inv.id);
    if (step && await approvals.canAct(user, step, inv.department_id, inv.created_by)) return true;
  }
  return false;
}

module.exports = function register(app) {
  app.get('/api/invoices', requireAuth, wrap(async (req, res) => {
    const deptIds = await visibleDeptIds(req.user);
    const invoices = await db.prepare(`${INV_LIST_SQL} ORDER BY i.id DESC`).all();
    res.json(deptIds === null ? invoices : invoices.filter((i) => canSeeDoc(deptIds, i, req.user.id, 'created_by')));
  }));

  app.get('/api/invoices/:id', requireAuth, wrap(async (req, res) => {
    const inv = await db.prepare(`${INV_LIST_SQL} WHERE i.id = ?`).get(req.params.id);
    if (!inv) return res.status(404).json({ error: 'Invoice not found' });
    if (!await canViewInvoice(req.user, inv)) {
      return res.status(403).json({ error: "This invoice belongs to another department — only its department head/deputy and finance can view it" });
    }
    inv.payments = await db.prepare('SELECT p.*, u.full_name AS created_by_name FROM payments p JOIN users u ON u.id = p.created_by WHERE p.invoice_id = ?').all(inv.id);
    inv.approval_chain = await approvals.getChain('invoice', inv.id, inv.department_id);
    // my_action: 'final' opens the TDS/booking dialog; 'step' is a plain approve
    inv.my_action = null;
    if (inv.status === 'pending') {
      const step = await approvals.currentStep('invoice', inv.id);
      if (step && await approvals.canAct(req.user, step, inv.department_id, inv.created_by)) {
        const remaining = inv.approval_chain.filter((s) => s.status === 'pending').length;
        inv.my_action = remaining <= 1 ? 'final' : 'step';
      }
    }
    res.json(inv);
  }));

  // invoice attachment download — token via header or ?token= (for plain <a href> links);
  // staff can fetch any attachment, a vendor only their own
  app.get('/api/invoices/:id/attachment', wrap(attachmentHandler));

  // any staff member may enter an invoice on behalf of a vendor (telco, utilities…);
  // it then routes through the approval matrix, ending with finance. Supports an
  // optional multipart attachment like the vendor portal.
  app.post('/api/invoices', requireAuth, async (req, res) => {
    upload.single('attachment')(req, res, async (uploadErr) => {
      try {
        if (uploadErr) throw uploadErr;
        if (req.file && !verifyFileSignature(path.join(UPLOAD_DIR, req.file.filename), req.file.originalname)) {
          throw new Error('The uploaded file does not look like a valid PDF, PNG or JPG');
        }
        const b = req.body;
        const po = await db.prepare('SELECT * FROM pos WHERE id = ?').get(Number(b.po_id));
        if (!po) throw new Error('PO not found');
        if (po.status === 'cancelled') throw new Error('Cannot invoice a cancelled PO');
        if (!b.invoice_date) throw new Error('Invoice date is required');
        const vendor = await db.prepare('SELECT * FROM vendors WHERE id = ?').get(po.vendor_id);
        let gstinId = Number(b.company_gstin_id) || po.company_gstin_id;
        if (modules.enabled('tax')) {
          if (!gstinId) throw new Error('Select the company GST registration for this invoice');
        } else {
          gstinId = gstinId || null;
        }
        const t = await prepareInvoiceTax(po, vendor, b);
        const { receivedDate, dueDate } = prepareReceiptAndDueDate(vendor, b);
        const gl = await prepareInvoiceGlFields(vendor, b);

        const match = await computeMatch(po.id, t.sub);
        // route the approval chain via the uploader's department, falling back to
        // the PO owner's department (dept head first, then finance)
        const invDeptId = req.user.department_id
          || (await db.prepare('SELECT department_id FROM users WHERE id = ?').get(po.created_by) || {}).department_id
          || null;
        // number allocation lives inside the same transaction as the insert so
        // concurrent submissions can't grab the same invoice number
        const { id, invNumber } = await db.tx(async () => {
          const invNumber = await nextNumber('INV', 'invoices', 'invoice_number');
          await assertNotDuplicateInvoice(po.vendor_id, b.vendor_invoice_ref);
          const invId = (await db.prepare(`INSERT INTO invoices
            (invoice_number, vendor_invoice_ref, po_id, vendor_id, company_gstin_id, invoice_date, received_date, due_date,
             place_of_supply_code, place_of_supply_state, hsn_sac_code, gl_description,
             subtotal, cgst_amount, sgst_amount, igst_amount, tax_amount, total,
             rcm, rcm_category_id, currency, fx_rate, foreign_amount,
             status, match_status, match_notes, gstr2b_status, department_id, attachment_path, attachment_name, created_by)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',?,?,?,?,?,?,?)`)
            .run(invNumber, b.vendor_invoice_ref || null, po.id, po.vendor_id, gstinId, b.invoice_date, receivedDate, dueDate,
                 gl.placeOfSupplyCode, gl.placeOfSupplyState, gl.hsnSacCode, gl.glDescription,
                 t.sub, t.cgst, t.sgst, t.igst, t.tax, t.total,
                 t.rcm, t.rcmCategoryId, b.currency || vendor.currency || 'INR',
                 Number(b.fx_rate) || null, Number(b.foreign_amount) || null,
                 match.status, match.notes, t.gstr2bStatus, invDeptId,
                 req.file ? req.file.filename : null, req.file ? req.file.originalname : null,
                 req.user.id)).lastInsertRowid;
          await approvals.createApprovals('invoice', invId, invDeptId, t.total);
          return { id: invId, invNumber };
        });
        audit(req.user.id, 'create', 'invoice', id, invNumber);
        const step = await approvals.currentStep('invoice', id);
        sendMail(stepEmails(step, invDeptId),
          `[P2P] Invoice ${invNumber} awaiting your approval — ${fmtInr(t.total)}`,
          [`${req.user.full_name} entered invoice <strong>${invNumber}</strong> (${fmtInr(t.total)}) from ${vendor.name} against ${po.po_number}.`,
           `3-way match: ${match.status}${match.status === 'mismatch' ? ` — ${match.notes}` : ''}`],
          `#/invoices/${id}`);
        res.status(201).json({ id, invoice_number: invNumber, match_status: match.status, match_notes: match.notes });
      } catch (e) {
        if (req.file) fs.unlink(path.join(UPLOAD_DIR, req.file.filename), () => {});
        res.status(400).json({ error: e.message || 'Request failed' });
      }
    });
  });

  // approval-matrix driven. Intermediate levels are a plain approve; the FINAL
  // level books the invoice (TDS section/rate chosen there, JE posted there —
  // both only with the tax module).
  app.post('/api/invoices/:id/approve', requireAuth, wrap(async (req, res) => {
    const inv = await db.prepare('SELECT * FROM invoices WHERE id = ?').get(req.params.id);
    if (!inv) return res.status(404).json({ error: 'Invoice not found' });
    if (inv.status !== 'pending') throw new Error(`Cannot approve an invoice with status "${inv.status}"`);
    const step = await approvals.currentStep('invoice', inv.id);
    if (!step) throw new Error('Nothing is pending approval on this invoice');
    if (req.user.id === inv.created_by && req.user.role !== 'admin') {
      throw new Error('Segregation of duties: you cannot approve an invoice you entered');
    }
    if (!await approvals.canAct(req.user, step, inv.department_id, inv.created_by)) {
      throw new Error(`This invoice is awaiting: ${await approvals.approverLabel(step.approver_kind, step.approver_ref, inv.department_id)}`);
    }
    const remaining = (await db.prepare(`SELECT COUNT(*) c FROM doc_approvals WHERE doc_type='invoice' AND doc_id=? AND status='pending'`).get(inv.id)).c;

    // intermediate level: record the sign-off, invoice stays pending for the next level
    if (remaining > 1) {
      await approvals.act('invoice', inv.id, req.user, true, (req.body || {}).comment, inv.department_id);
      audit(req.user.id, 'approve', 'invoice', inv.id, `${inv.invoice_number} (level ${step.seq})`);
      const next = await approvals.currentStep('invoice', inv.id);
      sendMail(stepEmails(next, inv.department_id),
        `[P2P] Invoice ${inv.invoice_number} awaiting your approval (level ${next.seq})`,
        [`Invoice <strong>${inv.invoice_number}</strong> (${fmtInr(inv.total)}) passed level ${step.seq} (${req.user.full_name}) and now needs your review — TDS and booking happen at your step.`],
        `#/invoices/${inv.id}`);
      return res.json({ ok: true, finished: false, awaiting: await approvals.approverLabel(next.approver_kind, next.approver_ref, inv.department_id) });
    }

    // final level: booking details required
    const b = req.body || {};
    const taxModule = modules.enabled('tax');

    // TDS: section 'none' or empty → no deduction; otherwise rate applies on taxable value.
    // A lower/nil-deduction certificate valid on the invoice date can supply the rate
    // instead of the section's standard master rate (finance can still override).
    let tdsSection = taxModule ? (b.tds_section || '').trim() : '';
    let tdsRate = 0, tdsAmount = 0, tdsCertificateId = null, tdsRateOverrideReason = null;
    if (tdsSection && tdsSection.toLowerCase() !== 'none') {
      tdsRate = Number(b.tds_rate);
      if (!(tdsRate >= 0 && tdsRate <= 40)) throw new Error('TDS rate must be between 0 and 40%');
      tdsAmount = r2(inv.subtotal * tdsRate / 100);
    } else {
      tdsSection = null;
    }
    const itc = b.itc_eligibility === 'ineligible' ? 'ineligible' : 'eligible';

    // RCM invoices may have IGST self-assessed at approval time
    let igst = inv.igst_amount;
    if (taxModule && inv.rcm && b.rcm_igst !== undefined && b.rcm_igst !== '') {
      igst = r2(Number(b.rcm_igst));
      if (!(igst >= 0)) throw new Error('Self-assessed IGST cannot be negative');
    }

    // GL-classification dimensions (tax module only) — sub-location/cost-centre
    // fall back to the invoice's department defaults when finance doesn't pick one
    let subLocation = null, costCentre = null, programProductCode = null, glPeriod = null;
    const customFields = [null, null, null, null, null];
    if (taxModule) {
      const dept = inv.department_id ? await db.prepare('SELECT * FROM departments WHERE id = ?').get(inv.department_id) : null;
      subLocation = (b.sub_location || '').trim() || (dept && dept.default_sub_location) || null;
      costCentre = (b.cost_centre || '').trim() || (dept && dept.default_cost_centre) || null;
      programProductCode = (b.program_product_code || '').trim() || null;
      glPeriod = (b.gl_period || '').trim() || inv.invoice_date.slice(0, 7);
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(glPeriod)) throw new Error('GL period must be a valid month in YYYY-MM format');
      for (let i = 0; i < 5; i++) customFields[i] = (b[`custom_field_${i + 1}`] || '').trim() || null;
    }

    const result = await db.tx(async () => {
      // Lock the invoice row and re-verify it is still pending: two final
      // approvals racing each other would otherwise both book it (double JE).
      const locked = await db.prepare('SELECT status FROM invoices WHERE id = ? FOR UPDATE').get(inv.id);
      if (!locked || locked.status !== 'pending') {
        throw new Error(`Invoice was already processed (status "${locked ? locked.status : 'missing'}")`);
      }
      // Certificate validation + threshold check under a row lock, in the same
      // transaction as the booking: concurrent approvals against the same
      // certificate serialize here, so its threshold can never be overshot.
      if (taxModule && tdsSection && b.tds_certificate_id) {
        const cert = await db.prepare(`SELECT * FROM vendor_tds_certificates WHERE id = ? AND vendor_id = ? AND tds_section = ? AND active = 1
          AND valid_from <= ? AND valid_to >= ? FOR UPDATE`).get(Number(b.tds_certificate_id), inv.vendor_id, tdsSection, inv.invoice_date, inv.invoice_date);
        if (!cert) throw new Error('That lower-TDS certificate is not valid for this vendor/section on the invoice date');
        // the lower rate applies only up to the certificate's threshold (its
        // authorised limit) — whichever comes first between that and its validity window
        if (cert.threshold_amount != null) {
          const utilized = (await db.prepare(`SELECT COALESCE(SUM(subtotal), 0) AS s FROM invoices
            WHERE tds_certificate_id = ? AND status NOT IN ('rejected', 'cancelled') AND id != ?`).get(cert.id, inv.id)).s;
          if (utilized + inv.subtotal > cert.threshold_amount) {
            throw new Error(`This certificate's threshold of ₹${cert.threshold_amount} would be exceeded (₹${utilized} already used + ₹${inv.subtotal} on this invoice) — use the standard TDS rate instead`);
          }
        }
        // claiming a certificate means deducting at exactly its authorised rate
        if (Math.abs(Number(cert.rate) - tdsRate) > 1e-9) {
          throw new Error(`Certificate ${cert.certificate_number} authorises exactly ${cert.rate}% — either use that rate or approve without the certificate`);
        }
        tdsCertificateId = cert.id;
      } else if (taxModule && tdsSection) {
        // No certificate: the rate must come from the section master. Finance
        // may still deviate, but only with an explicit reason that lands in
        // the audit trail — a mistyped rate should never pass silently.
        const masterRates = (await db.prepare('SELECT rate FROM tds_sections WHERE section = ? AND active = 1').all(tdsSection))
          .map((r) => Number(r.rate));
        if (!masterRates.some((r) => Math.abs(r - tdsRate) < 1e-9)) {
          tdsRateOverrideReason = (b.tds_rate_override_reason || '').trim();
          if (!tdsRateOverrideReason) {
            throw new Error(`TDS rate ${tdsRate}% does not match the ${tdsSection} master rate${masterRates.length === 1 ? '' : 's'} (${masterRates.join('%, ')}%) — provide an override reason to use it anyway`);
          }
        }
      }
      await approvals.act('invoice', inv.id, req.user, true, b.comment, inv.department_id);
      await db.prepare(`UPDATE invoices SET status='approved', approved_by=?, tds_section=?, tds_rate=?, tds_amount=?, tds_certificate_id=?,
                  itc_eligibility=?, igst_amount=?, tax_amount=?, sub_location=?, cost_centre=?, program_product_code=?, gl_period=?,
                  custom_field_1=?, custom_field_2=?, custom_field_3=?, custom_field_4=?, custom_field_5=? WHERE id=?`)
        .run(req.user.id, tdsSection, tdsRate, tdsAmount, tdsCertificateId, itc, igst,
             r2(inv.cgst_amount + inv.sgst_amount + igst), subLocation, costCentre, programProductCode, glPeriod,
             ...customFields, inv.id);
      if (!taxModule) return { jeNumber: null, tdsAmount: 0, netPayable: r2(inv.total) };
      const updated = await db.prepare('SELECT * FROM invoices WHERE id = ?').get(inv.id);
      const { jeId, jeNumber } = await postInvoiceBookingJE(updated, req.user.id);
      await db.prepare('UPDATE invoices SET booking_je_id = ? WHERE id = ?').run(jeId, inv.id);
      return { jeNumber, tdsAmount, netPayable: r2(updated.total - tdsAmount) };
    });
    audit(req.user.id, 'approve', 'invoice', inv.id,
      `${inv.invoice_number}${result.jeNumber ? ` (JE ${result.jeNumber})` : ''}${tdsRateOverrideReason ? ` — TDS rate override to ${tdsRate}%: ${tdsRateOverrideReason}` : ''}`);
    const approvedRecipients = inv.source === 'vendor' ? vendorEmails(inv.vendor_id) : [userEmail(inv.created_by)];
    sendMail(approvedRecipients,
      `Invoice ${inv.invoice_number} approved — net payable ${fmtInr(result.netPayable)}`,
      [`Invoice <strong>${inv.invoice_number}</strong>${inv.vendor_invoice_ref ? ` (ref ${inv.vendor_invoice_ref})` : ''} has been approved for payment.`,
       result.tdsAmount > 0 ? `TDS of ${fmtInr(result.tdsAmount)} will be deducted at source; net payable is ${fmtInr(result.netPayable)}.` : ''],
      inv.source === 'vendor' ? '/vendor' : `#/invoices/${inv.id}`);
    res.json({ ok: true, finished: true, ...result });
  }));

  app.post('/api/invoices/:id/reject', requireAuth, wrap(async (req, res) => {
    const inv = await db.prepare('SELECT * FROM invoices WHERE id = ?').get(req.params.id);
    if (!inv) return res.status(404).json({ error: 'Invoice not found' });
    if (inv.status !== 'pending') throw new Error(`Cannot reject an invoice with status "${inv.status}"`);
    await db.tx(async () => {
      await approvals.act('invoice', inv.id, req.user, false, req.body.reason, inv.department_id);
      await db.prepare(`UPDATE invoices SET status='rejected', approved_by=?, match_notes=? WHERE id=?`)
        .run(req.user.id, req.body.reason || inv.match_notes, inv.id);
    });
    audit(req.user.id, 'reject', 'invoice', inv.id, inv.invoice_number);
    sendMail(inv.source === 'vendor' ? vendorEmails(inv.vendor_id) : [userEmail(inv.created_by)],
      `Invoice ${inv.invoice_number} rejected`,
      [`Invoice <strong>${inv.invoice_number}</strong> was rejected by ${req.user.full_name}.`,
       req.body.reason ? `Reason: ${req.body.reason}` : ''],
      inv.source === 'vendor' ? '/vendor' : `#/invoices/${inv.id}`);
    res.json({ ok: true });
  }));
};

// exported so the standalone vendor-portal server can serve attachment
// downloads without mounting the whole staff invoices module
async function attachmentHandler(req, res) {
  const token = bearerToken(req) || req.query.token;
  if (!token) return res.status(401).json({ error: 'Authentication required' });
  let payload;
  try { payload = jwt.verify(token, JWT_SECRET); }
  catch { return res.status(401).json({ error: 'Invalid or expired token' }); }
  if (payload.kind !== 'staff' && payload.kind !== 'vendor') {
    return res.status(403).json({ error: 'Not an authenticated session' });
  }
  const inv = await db.prepare('SELECT * FROM invoices WHERE id = ?').get(req.params.id);
  if (!inv || !inv.attachment_path) return res.status(404).json({ error: 'No attachment on this invoice' });
  if (payload.kind === 'vendor') {
    const vu = await db.prepare('SELECT * FROM vendor_users WHERE id = ?').get(payload.sub);
    if (!vu || vu.vendor_id !== inv.vendor_id) return res.status(403).json({ error: 'Not your invoice' });
  } else {
    // staff: same department-visibility rule as the invoice detail page —
    // the attachment must not leak what the page itself refuses to show
    const user = await db.prepare('SELECT * FROM users WHERE id = ? AND active = 1').get(payload.sub);
    if (!user) return res.status(401).json({ error: 'Authentication required' });
    if (!await canViewInvoice(user, inv)) {
      return res.status(403).json({ error: "This invoice belongs to another department — only its department head/deputy and finance can view it" });
    }
  }
  const file = path.join(UPLOAD_DIR, path.basename(inv.attachment_path));
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'File missing on server' });
  res.download(file, inv.attachment_name || 'invoice-attachment');
}

module.exports.attachmentHandler = attachmentHandler;
