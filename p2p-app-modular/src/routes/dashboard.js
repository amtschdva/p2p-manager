// Core: dashboard KPIs, the My Approvals inbox and the shared form metadata.
// Sections that belong to disabled modules (payment releases, tax masters)
// simply come back empty so the SPA renders without special-casing.
const { db } = require('../db');
const modules = require('../modules');
const approvals = require('../approvals');
const { requireAuth, wrap, financeHead } = require('../context');
const { PR_LIST_SQL, INV_LIST_SQL, PAY_LIST_SQL, GST_STATES } = require('../lib/queries');

module.exports = function register(app) {
  // combined lookup used by invoice/PO/approval forms. Departments are core;
  // the tax masters are only populated when the tax module is licensed.
  app.get('/api/meta/tax', requireAuth, async (req, res) => {
    const taxOn = modules.enabled('tax');
    const labelRows = taxOn ? await db.prepare(`SELECT key, value FROM app_settings WHERE key LIKE 'custom_field_%_label'`).all() : [];
    const byKey = Object.fromEntries(labelRows.map((r) => [r.key, r.value]));
    const custom_field_labels = {};
    for (let i = 1; i <= 5; i++) custom_field_labels[`custom_field_${i}`] = byKey[`custom_field_${i}_label`] || `Custom Field ${i}`;
    res.json({
      modules: modules.ENABLED,
      gstins: taxOn ? await db.prepare('SELECT * FROM company_gstins WHERE active = 1 ORDER BY id').all() : [],
      tds_sections: taxOn ? await db.prepare('SELECT * FROM tds_sections WHERE active = 1 ORDER BY section, rate').all() : [],
      rcm_categories: taxOn ? await db.prepare('SELECT * FROM rcm_categories WHERE active = 1 ORDER BY id').all() : [],
      ap_account_codes: taxOn ? await db.prepare('SELECT * FROM ap_account_codes WHERE active = 1 ORDER BY code').all() : [],
      sub_locations: taxOn ? await db.prepare('SELECT * FROM sub_locations WHERE active = 1 ORDER BY code').all() : [],
      cost_centres: taxOn ? await db.prepare('SELECT * FROM cost_centres WHERE active = 1 ORDER BY code').all() : [],
      gst_states: taxOn ? GST_STATES : [],
      custom_field_labels,
      departments: await db.prepare(`
        SELECT d.*, u.full_name AS head_name FROM departments d
        LEFT JOIN users u ON u.id = d.head_user_id WHERE d.active = 1 ORDER BY d.name`).all(),
    });
  });

  // ---------- my approvals (everything awaiting the signed-in user) ----------
  app.get('/api/my-approvals', requireAuth, wrap(async (req, res) => {
    const me = req.user;
    const prs = [];
    for (const pr of await db.prepare(`${PR_LIST_SQL} WHERE p.status = 'submitted' ORDER BY p.id`).all()) {
      if (pr.requester_id === me.id && me.role !== 'admin') continue;
      const step = await approvals.currentStep('pr', pr.id);
      if (!step || !(await approvals.canAct(me, step, pr.department_id))) continue;
      prs.push({ id: pr.id, number: pr.pr_number, title: `${pr.requester_name} · ${pr.department_name || pr.department || '—'}`, amount: pr.estimated_total, since: pr.created_at });
    }

    const invoices = [];
    for (const inv of await db.prepare(`${INV_LIST_SQL} WHERE i.status = 'pending' ORDER BY i.id`).all()) {
      const step = await approvals.currentStep('invoice', inv.id);
      if (!step || !(await approvals.canAct(me, step, inv.department_id))) continue;
      const remaining = (await db.prepare(`SELECT COUNT(*) c FROM doc_approvals WHERE doc_type='invoice' AND doc_id=? AND status='pending'`).get(inv.id)).c;
      invoices.push({ id: inv.id, number: inv.invoice_number, title: `${inv.vendor_name} · ${inv.po_number}`, amount: inv.total, since: inv.created_at, final: remaining <= 1, match: inv.match_status });
    }

    const grns = (me.role === 'approver' || me.role === 'admin')
      ? await db.prepare(`
          SELECT g.id, g.grn_number AS number, po.po_number || ' · ' || v.name AS title, g.created_at AS since
          FROM grns g JOIN pos po ON po.id = g.po_id JOIN vendors v ON v.id = po.vendor_id
          WHERE g.status = 'pending' ORDER BY g.id`).all()
      : [];

    const vendors = (me.role === 'finance' || me.role === 'admin')
      ? await db.prepare(`SELECT id, name AS number, COALESCE(contact_person,'') || ' · ' || COALESCE(email,'') AS title, created_at AS since
          FROM vendors WHERE verified = 0 AND status != 'blocked' ORDER BY id`).all()
      : [];

    // pending payments appear only for whoever can actually release them:
    // the Finance department head (or admin; any other finance user if no head set)
    let payments = [];
    if (modules.enabled('payments')) {
      const payHead = await financeHead();
      const canRelease = me.role === 'admin' || (payHead ? me.id === payHead.head_user_id : me.role === 'finance');
      payments = canRelease
        ? (await db.prepare(`${PAY_LIST_SQL} WHERE p.status = 'pending_release' ORDER BY p.id`).all())
            .filter((p) => p.created_by !== me.id || me.role === 'admin')
            .map((p) => ({ id: p.id, number: p.payment_number, title: `${p.vendor_name} · ${p.invoice_number} · prepared by ${p.created_by_name}`, amount: p.amount, since: p.created_at }))
        : [];
    }

    res.json({ prs, invoices, grns, vendors, payments,
      total: prs.length + invoices.length + grns.length + vendors.length + payments.length });
  }));

  // ---------- dashboard ----------
  app.get('/api/dashboard', requireAuth, wrap(async (req, res) => {
    const kpis = {
      pending_prs: (await db.prepare(`SELECT COUNT(*) c FROM prs WHERE status='submitted'`).get()).c,
      open_pos: (await db.prepare(`SELECT COUNT(*) c FROM pos WHERE status IN ('open','sent','partially_received')`).get()).c,
      pending_invoices: (await db.prepare(`SELECT COUNT(*) c FROM invoices WHERE status='pending'`).get()).c,
      outstanding_amount: (await db.prepare(`
        SELECT COALESCE(SUM(i.total - i.tds_amount - COALESCE((SELECT SUM(amount) FROM payments WHERE invoice_id=i.id AND status = 'released'),0)),0) v
        FROM invoices i WHERE i.status IN ('approved','partially_paid')`).get()).v,
      paid_this_month: (await db.prepare(`SELECT COALESCE(SUM(amount),0) v FROM payments WHERE status = 'released' AND substr(payment_date, 1, 7) = to_char(now(), 'YYYY-MM')`).get()).v,
      active_vendors: (await db.prepare(`SELECT COUNT(*) c FROM vendors WHERE status='active'`).get()).c,
      vendors_to_verify: (await db.prepare(`SELECT COUNT(*) c FROM vendors WHERE verified = 0 AND status != 'blocked'`).get()).c,
      pending_grns: (await db.prepare(`SELECT COUNT(*) c FROM grns WHERE status='pending'`).get()).c,
    };
    const spendByVendor = await db.prepare(`
      SELECT v.name, SUM(p.amount) AS total FROM payments p
      JOIN invoices i ON i.id = p.invoice_id JOIN vendors v ON v.id = i.vendor_id
      WHERE p.status = 'released'
      GROUP BY v.id ORDER BY total DESC LIMIT 8`).all();
    const poByStatus = await db.prepare(`SELECT status, COUNT(*) AS count FROM pos GROUP BY status`).all();
    const monthlyPayments = (await db.prepare(`
      SELECT substr(payment_date, 1, 7) AS month, SUM(amount) AS total
      FROM payments WHERE status = 'released' GROUP BY month ORDER BY month DESC LIMIT 12`).all()).reverse();
    const invoiceAging = await db.prepare(`
      SELECT CASE
        WHEN (CURRENT_DATE - COALESCE(due_date, invoice_date)::date) <= 0 THEN 'Not due'
        WHEN (CURRENT_DATE - COALESCE(due_date, invoice_date)::date) <= 30 THEN '1-30 days'
        WHEN (CURRENT_DATE - COALESCE(due_date, invoice_date)::date) <= 60 THEN '31-60 days'
        ELSE '60+ days' END AS bucket,
        SUM(total - COALESCE((SELECT SUM(amount) FROM payments WHERE invoice_id = invoices.id AND status = 'released'), 0)) AS amount
      FROM invoices WHERE status IN ('pending','approved','partially_paid')
      GROUP BY bucket`).all();
    // finance and admin see the whole activity stream (they work across every
    // department); everyone else sees only what they did themselves
    const seesAllActivity = ['admin', 'finance'].includes(req.user.role);
    const recentActivity = seesAllActivity
      ? await db.prepare(`
          SELECT a.*, u.full_name FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
          WHERE a.action != 'login' ORDER BY a.id DESC LIMIT 10`).all()
      : await db.prepare(`
          SELECT a.*, u.full_name FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
          WHERE a.action != 'login' AND a.user_id = ? ORDER BY a.id DESC LIMIT 10`).all(req.user.id);
    res.json({ kpis, spendByVendor, poByStatus, monthlyPayments, invoiceAging, recentActivity });
  }));
};
