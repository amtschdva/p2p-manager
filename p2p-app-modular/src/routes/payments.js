// Module "payments": maker-checker payment workflow + bank bulk-upload file.
// A finance user PREPARES a payment (no accounting effect); a DIFFERENT finance
// user (or admin) RELEASES it — the JE (tax module), invoice status and vendor
// visibility all happen at release. Pending payments reserve the outstanding
// balance. Releases are reserved for the head of the "Finance" department.
const jwt = require('jsonwebtoken');
const { db, audit, nextNumber } = require('../db');
const modules = require('../modules');
const { postPaymentJE, r2 } = require('../journal');
const { JWT_SECRET, requireAuth, requireRole, wrap, fmtInr, bearerToken, financeHead } = require('../context');
const { INV_LIST_SQL, PAY_LIST_SQL } = require('../lib/queries');
const { sendMail, usersByRole, userEmail, vendorEmails } = require('../mailer');

module.exports = function register(app) {
  app.get('/api/payments', requireAuth, async (req, res) => {
    res.json(await db.prepare(`${PAY_LIST_SQL} ORDER BY p.id DESC`).all());
  });

  app.post('/api/payments', requireAuth, requireRole('finance'), wrap(async (req, res) => {
    const { invoice_id, amount, payment_date, method, reference, notes } = req.body;
    const inv = await db.prepare(`${INV_LIST_SQL} WHERE i.id = ?`).get(invoice_id);
    if (!inv) throw new Error('Invoice not found');
    if (!['approved', 'partially_paid'].includes(inv.status)) {
      throw new Error(`Payments can only be made against approved invoices (current status: ${inv.status})`);
    }
    const amt = Number(amount);
    if (!(amt > 0)) throw new Error('Payment amount must be greater than zero');
    // Balance check + insert in one transaction, with the invoice row locked:
    // two payments prepared at the same moment would otherwise both read the
    // old committed total and together overshoot the outstanding balance.
    const { id, payNumber } = await db.tx(async () => {
      await db.prepare('SELECT id FROM invoices WHERE id = ? FOR UPDATE').get(invoice_id);
      // vendor is owed total − TDS; released AND pending payments both consume the balance
      const netPayable = r2(inv.total - inv.tds_amount);
      const committed = (await db.prepare(`SELECT COALESCE(SUM(amount),0) s FROM payments WHERE invoice_id = ? AND status != 'cancelled'`).get(invoice_id)).s;
      const outstanding = r2(netPayable - committed);
      if (amt > outstanding + 0.01) throw new Error(`Amount exceeds outstanding balance of ₹${outstanding.toFixed(2)} (net of TDS, incl. payments awaiting release)`);

      const payNumber = await nextNumber('PAY', 'payments', 'payment_number');
      const id = (await db.prepare(`INSERT INTO payments (payment_number, invoice_id, amount, payment_date, method, reference, notes, status, created_by)
        VALUES (?,?,?,?,?,?,?,'pending_release',?)`)
        .run(payNumber, invoice_id, amt, payment_date || new Date().toISOString().slice(0, 10),
             method || 'bank_transfer', reference || null, notes || null, req.user.id)).lastInsertRowid;
      return { id, payNumber };
    });
    audit(req.user.id, 'create', 'payment', id, `${payNumber} (pending release)`);
    const makerEmail = await userEmail(req.user.id);
    const headRow = await financeHead();
    const checkerEmails = headRow
      ? [await userEmail(headRow.head_user_id)]
      : (await usersByRole('finance', 'admin'));
    sendMail(checkerEmails.filter((e) => e !== makerEmail),
      `[P2P] Payment ${payNumber} awaiting release — ${fmtInr(amt)}`,
      [`${req.user.full_name} prepared payment <strong>${payNumber}</strong> of <strong>${fmtInr(amt)}</strong> to ${inv.vendor_name} against ${inv.invoice_number}.`,
       'A second finance user must review and release it.'],
      '#/payments');
    res.status(201).json({ id, payment_number: payNumber, status: 'pending_release' });
  }));

  app.post('/api/payments/:id/release', requireAuth, requireRole('finance'), wrap(async (req, res) => {
    const p = await db.prepare('SELECT * FROM payments WHERE id = ?').get(req.params.id);
    if (!p) return res.status(404).json({ error: 'Payment not found' });
    if (p.status !== 'pending_release') throw new Error(`Cannot release a payment with status "${p.status}"`);
    if (p.created_by === req.user.id && req.user.role !== 'admin') {
      throw new Error('Maker-checker: the user who prepared a payment cannot release it — a different user must');
    }
    const head = await financeHead();
    if (req.user.role !== 'admin' && head && req.user.id !== head.head_user_id) {
      throw new Error('Payments can only be released by the Finance department head');
    }
    const inv = await db.prepare(`${INV_LIST_SQL} WHERE i.id = ?`).get(p.invoice_id);
    const result = await db.tx(async () => {
      await db.prepare(`UPDATE payments SET status='released', released_by=?, released_at=to_char(now(), 'YYYY-MM-DD HH24:MI:SS'), reference=? WHERE id=?`)
        .run(req.user.id, (req.body || {}).reference || p.reference, p.id);
      const releasedPaid = (await db.prepare(`SELECT COALESCE(SUM(amount),0) s FROM payments WHERE invoice_id = ? AND status='released'`).get(p.invoice_id)).s;
      const netPayable = r2(inv.total - inv.tds_amount);
      await db.prepare('UPDATE invoices SET status = ? WHERE id = ?')
        .run(releasedPaid >= netPayable - 0.01 ? 'paid' : 'partially_paid', p.invoice_id);
      if (!modules.enabled('tax')) return { jeNumber: null };
      const payment = await db.prepare('SELECT * FROM payments WHERE id = ?').get(p.id);
      const { jeId, jeNumber } = await postPaymentJE(payment, inv, req.user.id);
      await db.prepare('UPDATE payments SET je_id = ? WHERE id = ?').run(jeId, p.id);
      return { jeNumber };
    });
    audit(req.user.id, 'release', 'payment', p.id,
      `${p.payment_number}${result.jeNumber ? ` (JE ${result.jeNumber})` : ''}`);
    sendMail(vendorEmails(inv.vendor_id),
      `Payment released — ${p.payment_number} (${fmtInr(p.amount)})`,
      [`A payment of <strong>${fmtInr(p.amount)}</strong> against invoice ${inv.invoice_number}${inv.vendor_invoice_ref ? ` (your ref ${inv.vendor_invoice_ref})` : ''} has been released.`,
       `Method: ${p.method.replace('_', ' ')}${p.reference ? ` · Reference: ${p.reference}` : ''}`],
      '/vendor');
    sendMail([userEmail(p.created_by)],
      `[P2P] Payment ${p.payment_number} released`,
      [`${req.user.full_name} released payment <strong>${p.payment_number}</strong> (${fmtInr(p.amount)}) to ${inv.vendor_name}.`],
      '#/payments');
    res.json({ ok: true, ...result });
  }));

  app.post('/api/payments/:id/cancel', requireAuth, requireRole('finance'), wrap(async (req, res) => {
    const p = await db.prepare('SELECT * FROM payments WHERE id = ?').get(req.params.id);
    if (!p) return res.status(404).json({ error: 'Payment not found' });
    if (p.status !== 'pending_release') throw new Error('Only payments awaiting release can be cancelled');
    await db.prepare(`UPDATE payments SET status='cancelled' WHERE id=?`).run(p.id);
    audit(req.user.id, 'cancel', 'payment', p.id, p.payment_number);
    res.json({ ok: true });
  }));

  // bank-upload file: all payments awaiting release, with beneficiary bank details
  app.get('/api/payments/export-bank', wrap(async (req, res) => {
    const token = bearerToken(req) || req.query.token;
    let payload;
    try { payload = jwt.verify(token || '', JWT_SECRET); }
    catch { return res.status(401).json({ error: 'Authentication required' }); }
    if (payload.kind !== 'staff') return res.status(403).json({ error: 'Not a staff session' });
    const rows = await db.prepare(`${PAY_LIST_SQL} WHERE p.status = 'pending_release' ORDER BY p.id`).all();
    const csvEsc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const csv = ['payment_number,payment_date,beneficiary_name,bank_name,account_number,ifsc,amount,method,narration',
      ...rows.map((p) => [p.payment_number, p.payment_date, p.vendor_name, p.bank_name, p.bank_account, p.ifsc,
        p.amount.toFixed(2), p.method, `${p.invoice_number} ${p.notes || ''}`.trim()].map(csvEsc).join(','))].join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="bank-payments-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(csv);
  }));
};
