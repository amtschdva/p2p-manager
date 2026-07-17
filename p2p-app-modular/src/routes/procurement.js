// Core: purchase requisitions, purchase orders, goods receipts.
const { db, audit, nextNumber } = require('../db');
const modules = require('../modules');
const approvals = require('../approvals');
const { requireAuth, requireRole, wrap, fmtInr } = require('../context');
const { PR_LIST_SQL, PO_LIST_SQL, refreshPoReceiptStatus, computeMatch, visibleDeptIds, canSeeDoc } = require('../lib/queries');
const { sendMail, usersByRole, userEmail, stepEmails } = require('../mailer');

module.exports = function register(app) {
  // ---------- purchase requisitions ----------
  app.get('/api/prs', requireAuth, wrap(async (req, res) => {
    const deptIds = await visibleDeptIds(req.user);
    let prs = await db.prepare(`${PR_LIST_SQL} ORDER BY p.id DESC`).all();
    if (deptIds !== null) prs = prs.filter((p) => canSeeDoc(deptIds, p, req.user.id, 'requester_id'));
    for (const pr of prs) {
      if (pr.status === 'submitted') {
        const step = await approvals.currentStep('pr', pr.id);
        pr.awaiting = step ? await approvals.approverLabel(step.approver_kind, step.approver_ref, pr.department_id) : null;
      }
    }
    res.json(prs);
  }));

  app.get('/api/prs/:id', requireAuth, wrap(async (req, res) => {
    const pr = await db.prepare(`${PR_LIST_SQL} WHERE p.id = ?`).get(req.params.id);
    if (!pr) return res.status(404).json({ error: 'PR not found' });
    // dept scoping, with the same exception as invoices: whoever the matrix
    // assigned to the current pending step may always open the document
    const deptIds = await visibleDeptIds(req.user);
    let mayView = canSeeDoc(deptIds, pr, req.user.id, 'requester_id');
    if (!mayView && pr.status === 'submitted') {
      const pendingStep = await approvals.currentStep('pr', pr.id);
      mayView = !!pendingStep && await approvals.canAct(req.user, pendingStep, pr.department_id);
    }
    if (!mayView) {
      return res.status(403).json({ error: "This requisition belongs to another department — only its department head/deputy and finance can view it" });
    }
    pr.items = await db.prepare('SELECT * FROM pr_items WHERE pr_id = ?').all(pr.id);
    pr.approval_chain = await approvals.getChain('pr', pr.id, pr.department_id);
    const step = pr.status === 'submitted' ? await approvals.currentStep('pr', pr.id) : null;
    pr.can_act = !!step && await approvals.canAct(req.user, step, pr.department_id)
      && (pr.requester_id !== req.user.id || req.user.role === 'admin');
    res.json(pr);
  }));

  app.post('/api/prs', requireAuth, wrap(async (req, res) => {
    const { department_id, needed_by, justification, items } = req.body;
    if (!Array.isArray(items) || items.length === 0) throw new Error('At least one line item is required');
    for (const it of items) {
      if (!it.description || !(Number(it.quantity) > 0)) throw new Error('Each item needs a description and quantity > 0');
    }
    const deptId = Number(department_id) || req.user.department_id || null;
    const dept = deptId ? await db.prepare('SELECT * FROM departments WHERE id = ?').get(deptId) : null;
    const estimate = items.reduce((s, it) => s + Number(it.quantity) * (Number(it.est_unit_price) || 0), 0);
    const { id, prNumber } = await db.tx(async () => {
      const prNumber = await nextNumber('PR', 'prs', 'pr_number');
      const prId = (await db.prepare('INSERT INTO prs (pr_number, requester_id, department, department_id, needed_by, justification) VALUES (?,?,?,?,?,?)')
        .run(prNumber, req.user.id, dept ? dept.name : null, deptId, needed_by || null, justification || null)).lastInsertRowid;
      // item_id links a line to the items master once the inventory module lands
      const ins = db.prepare('INSERT INTO pr_items (pr_id, item_id, description, quantity, unit, est_unit_price) VALUES (?,?,?,?,?,?)');
      for (const it of items) await ins.run(prId, Number(it.item_id) || null, it.description, Number(it.quantity), it.unit || 'EA', Number(it.est_unit_price) || 0);
      await approvals.createApprovals('pr', prId, deptId, estimate);
      return { id: prId, prNumber };
    });
    audit(req.user.id, 'create', 'pr', id, prNumber);
    const step = await approvals.currentStep('pr', id);
    sendMail(stepEmails(step, deptId),
      `[P2P] ${prNumber} awaiting your approval — ${fmtInr(estimate)}`,
      [`${req.user.full_name} raised requisition <strong>${prNumber}</strong>${dept ? ` (${dept.name})` : ''} estimated at <strong>${fmtInr(estimate)}</strong>.`,
       justification ? `Justification: ${justification}` : ''],
      `#/prs/${id}`);
    res.status(201).json({ id, pr_number: prNumber });
  }));

  // approval-matrix driven: the current pending level's approver acts (admin can always act)
  app.post('/api/prs/:id/approve', requireAuth, wrap(async (req, res) => {
    const pr = await db.prepare('SELECT * FROM prs WHERE id = ?').get(req.params.id);
    if (!pr) return res.status(404).json({ error: 'PR not found' });
    if (pr.status !== 'submitted') throw new Error(`Cannot approve a PR with status "${pr.status}"`);
    if (pr.requester_id === req.user.id && req.user.role !== 'admin') throw new Error('You cannot approve your own requisition');
    const result = await db.tx(async () => {
      const r = await approvals.act('pr', pr.id, req.user, true, req.body.comment, pr.department_id);
      if (r.finished) {
        await db.prepare(`UPDATE prs SET status='approved', approver_id=?, approved_at=to_char(now(), 'YYYY-MM-DD HH24:MI:SS') WHERE id=?`).run(req.user.id, pr.id);
      }
      return r;
    });
    audit(req.user.id, 'approve', 'pr', pr.id, `${pr.pr_number}${result.finished ? '' : ' (level ' + result.step.seq + ')'}`);
    if (result.finished) {
      sendMail([userEmail(pr.requester_id)],
        `[P2P] ${pr.pr_number} approved`,
        [`Your requisition <strong>${pr.pr_number}</strong> is fully approved. Procurement can now convert it to a purchase order.`],
        `#/prs/${pr.id}`);
    } else {
      const next = await approvals.currentStep('pr', pr.id);
      sendMail(stepEmails(next, pr.department_id),
        `[P2P] ${pr.pr_number} awaiting your approval (level ${next.seq})`,
        [`Requisition <strong>${pr.pr_number}</strong> passed level ${result.step.seq} (${req.user.full_name}) and now needs your approval.`],
        `#/prs/${pr.id}`);
    }
    res.json({ ok: true, finished: result.finished });
  }));

  app.post('/api/prs/:id/reject', requireAuth, wrap(async (req, res) => {
    const pr = await db.prepare('SELECT * FROM prs WHERE id = ?').get(req.params.id);
    if (!pr) return res.status(404).json({ error: 'PR not found' });
    if (pr.status !== 'submitted') throw new Error(`Cannot reject a PR with status "${pr.status}"`);
    await db.tx(async () => {
      await approvals.act('pr', pr.id, req.user, false, req.body.reason, pr.department_id);
      await db.prepare(`UPDATE prs SET status='rejected', approver_id=?, rejection_reason=? WHERE id=?`)
        .run(req.user.id, req.body.reason || null, pr.id);
    });
    audit(req.user.id, 'reject', 'pr', pr.id, pr.pr_number);
    sendMail([userEmail(pr.requester_id)],
      `[P2P] ${pr.pr_number} rejected`,
      [`Your requisition <strong>${pr.pr_number}</strong> was rejected by ${req.user.full_name}.`,
       req.body.reason ? `Reason: ${req.body.reason}` : ''],
      `#/prs/${pr.id}`);
    res.json({ ok: true });
  }));

  // ---------- purchase orders ----------
  app.get('/api/pos', requireAuth, async (req, res) => {
    res.json(await db.prepare(`${PO_LIST_SQL} ORDER BY po.id DESC`).all());
  });

  app.get('/api/pos/:id', requireAuth, wrap(async (req, res) => {
    const po = await db.prepare(`${PO_LIST_SQL} WHERE po.id = ?`).get(req.params.id);
    if (!po) return res.status(404).json({ error: 'PO not found' });
    po.items = await db.prepare(`
      SELECT pi.*,
        COALESCE((SELECT SUM(gi.quantity_received) FROM grn_items gi JOIN grns g ON g.id = gi.grn_id
                  WHERE gi.po_item_id = pi.id AND g.status = 'approved'), 0) AS received_qty,
        COALESCE((SELECT SUM(gi.quantity_received) FROM grn_items gi JOIN grns g ON g.id = gi.grn_id
                  WHERE gi.po_item_id = pi.id AND g.status = 'pending'), 0) AS pending_qty
      FROM po_items pi WHERE pi.po_id = ?`).all(po.id);
    po.grns = await db.prepare('SELECT g.*, u.full_name AS received_by_name FROM grns g JOIN users u ON u.id = g.received_by WHERE g.po_id = ?').all(po.id);
    po.invoices = await db.prepare('SELECT id, invoice_number, total, status, match_status, source FROM invoices WHERE po_id = ?').all(po.id);
    res.json(po);
  }));

  app.post('/api/pos', requireAuth, requireRole('procurement'), wrap(async (req, res) => {
    const { pr_id, vendor_id, company_gstin_id, expected_date, notes, items } = req.body;
    if (!vendor_id) throw new Error('Vendor is required');
    // the buying GST registration is a tax-module concept; without it POs carry no GSTIN
    let gstin = null;
    if (modules.enabled('tax')) {
      gstin = await db.prepare('SELECT * FROM company_gstins WHERE id = ? AND active = 1').get(company_gstin_id);
      if (!gstin) throw new Error('Select the company GST registration this PO is procured under');
    }
    const vendor = await db.prepare('SELECT * FROM vendors WHERE id = ?').get(vendor_id);
    if (!vendor) throw new Error('Vendor not found');
    if (vendor.status !== 'active') throw new Error(`Vendor "${vendor.name}" is ${vendor.status}; POs can only be raised on active vendors`);
    if (!Array.isArray(items) || items.length === 0) throw new Error('At least one line item is required');
    for (const it of items) {
      if (!it.description || !(Number(it.quantity) > 0)) throw new Error('Each item needs a description and quantity > 0');
    }
    if (pr_id) {
      const pr = await db.prepare('SELECT * FROM prs WHERE id = ?').get(pr_id);
      if (!pr) throw new Error('Linked PR not found');
      if (pr.status !== 'approved') throw new Error('PO can only be created from an approved PR');
    }
    const { id, poNumber } = await db.tx(async () => {
      const poNumber = await nextNumber('PO', 'pos', 'po_number');
      const poId = (await db.prepare('INSERT INTO pos (po_number, pr_id, vendor_id, company_gstin_id, created_by, expected_date, notes) VALUES (?,?,?,?,?,?,?)')
        .run(poNumber, pr_id || null, vendor_id, gstin ? gstin.id : null, req.user.id, expected_date || null, notes || null)).lastInsertRowid;
      const ins = db.prepare('INSERT INTO po_items (po_id, item_id, description, quantity, unit, unit_price) VALUES (?,?,?,?,?,?)');
      for (const it of items) await ins.run(poId, Number(it.item_id) || null, it.description, Number(it.quantity), it.unit || 'EA', Number(it.unit_price) || 0);
      if (pr_id) await db.prepare(`UPDATE prs SET status='converted' WHERE id=?`).run(pr_id);
      return { id: poId, poNumber };
    });
    audit(req.user.id, 'create', 'po', id, poNumber);
    res.status(201).json({ id, po_number: poNumber });
  }));

  app.post('/api/pos/:id/status', requireAuth, requireRole('procurement'), wrap(async (req, res) => {
    const po = await db.prepare('SELECT * FROM pos WHERE id = ?').get(req.params.id);
    if (!po) return res.status(404).json({ error: 'PO not found' });
    const { status } = req.body;
    const allowed = ['sent', 'closed', 'cancelled'];
    if (!allowed.includes(status)) throw new Error(`Status must be one of: ${allowed.join(', ')}`);
    if (status === 'cancelled') {
      const grnCount = (await db.prepare('SELECT COUNT(*) AS c FROM grns WHERE po_id = ?').get(po.id)).c;
      if (grnCount > 0) throw new Error('Cannot cancel a PO that already has goods receipts');
    }
    await db.prepare('UPDATE pos SET status = ? WHERE id = ?').run(status, po.id);
    audit(req.user.id, `status:${status}`, 'po', po.id, po.po_number);
    res.json({ ok: true });
  }));

  // ---------- GRN ----------
  app.get('/api/grns', requireAuth, async (req, res) => {
    res.json(await db.prepare(`
      SELECT g.*, po.po_number, v.name AS vendor_name, u.full_name AS received_by_name, ap.full_name AS approved_by_name,
        (SELECT COUNT(*) FROM grn_items WHERE grn_id = g.id) AS line_count
      FROM grns g
      JOIN pos po ON po.id = g.po_id
      JOIN vendors v ON v.id = po.vendor_id
      JOIN users u ON u.id = g.received_by
      LEFT JOIN users ap ON ap.id = g.approved_by
      ORDER BY g.id DESC`).all());
  });

  app.get('/api/grns/:id', requireAuth, wrap(async (req, res) => {
    const grn = await db.prepare(`
      SELECT g.*, po.po_number, v.name AS vendor_name, u.full_name AS received_by_name, ap.full_name AS approved_by_name
      FROM grns g JOIN pos po ON po.id = g.po_id JOIN vendors v ON v.id = po.vendor_id JOIN users u ON u.id = g.received_by
      LEFT JOIN users ap ON ap.id = g.approved_by
      WHERE g.id = ?`).get(req.params.id);
    if (!grn) return res.status(404).json({ error: 'GRN not found' });
    grn.items = await db.prepare(`
      SELECT gi.*, pi.description, pi.unit FROM grn_items gi JOIN po_items pi ON pi.id = gi.po_item_id WHERE gi.grn_id = ?`).all(grn.id);
    res.json(grn);
  }));

  app.post('/api/grns', requireAuth, requireRole('procurement'), wrap(async (req, res) => {
    const { po_id, received_date, notes, items } = req.body;
    const po = await db.prepare('SELECT * FROM pos WHERE id = ?').get(po_id);
    if (!po) throw new Error('PO not found');
    if (['cancelled', 'closed'].includes(po.status)) throw new Error(`Cannot receive goods against a ${po.status} PO`);
    if (!Array.isArray(items) || items.length === 0) throw new Error('At least one receipt line is required');

    // validate against outstanding quantities (pending + approved receipts both count, so goods can't be double-booked)
    const poItems = await db.prepare(`
      SELECT pi.*, COALESCE((SELECT SUM(gi.quantity_received) FROM grn_items gi JOIN grns g ON g.id = gi.grn_id
                             WHERE gi.po_item_id = pi.id AND g.status != 'rejected'), 0) AS received_qty
      FROM po_items pi WHERE pi.po_id = ?`).all(po_id);
    const byId = Object.fromEntries(poItems.map(i => [i.id, i]));
    let anyQty = false;
    for (const it of items) {
      const line = byId[it.po_item_id];
      if (!line) throw new Error('Receipt line refers to an item not on this PO');
      const qty = Number(it.quantity_received) || 0;
      if (qty < 0) throw new Error('Received quantity cannot be negative');
      if (qty > 0) anyQty = true;
      if (line.received_qty + qty > line.quantity) {
        throw new Error(`"${line.description}": receiving ${qty} would exceed ordered quantity (${line.quantity}, already received ${line.received_qty})`);
      }
    }
    if (!anyQty) throw new Error('Enter a received quantity on at least one line');

    const { id, grnNumber } = await db.tx(async () => {
      const grnNumber = await nextNumber('GRN', 'grns', 'grn_number');
      const grnId = (await db.prepare(`INSERT INTO grns (grn_number, po_id, received_by, received_date, notes, status) VALUES (?,?,?,?,?,'pending')`)
        .run(grnNumber, po_id, req.user.id, received_date || new Date().toISOString().slice(0, 10), notes || null)).lastInsertRowid;
      const ins = db.prepare('INSERT INTO grn_items (grn_id, po_item_id, quantity_received, condition_notes) VALUES (?,?,?,?)');
      for (const it of items) {
        const qty = Number(it.quantity_received) || 0;
        if (qty > 0) await ins.run(grnId, it.po_item_id, qty, it.condition_notes || null);
      }
      return { id: grnId, grnNumber };
    });
    audit(req.user.id, 'create', 'grn', id, grnNumber);
    sendMail(usersByRole('approver', 'admin'),
      `[P2P] ${grnNumber} awaiting approval`,
      [`${req.user.full_name} recorded goods receipt <strong>${grnNumber}</strong> against ${po.po_number}. Please review and approve it so the receipt counts toward matching.`],
      `#/grns/${id}`);
    res.status(201).json({ id, grn_number: grnNumber, status: 'pending' });
  }));

  app.post('/api/grns/:id/approve', requireAuth, requireRole('approver'), wrap(async (req, res) => {
    const grn = await db.prepare('SELECT * FROM grns WHERE id = ?').get(req.params.id);
    if (!grn) return res.status(404).json({ error: 'GRN not found' });
    if (grn.status !== 'pending') throw new Error(`Cannot approve a GRN with status "${grn.status}"`);
    await db.tx(async () => {
      await db.prepare(`UPDATE grns SET status = 'approved', approved_by = ?, approved_at = to_char(now(), 'YYYY-MM-DD HH24:MI:SS') WHERE id = ?`)
        .run(req.user.id, grn.id);
      await refreshPoReceiptStatus(grn.po_id);
      // newly received goods may resolve mismatches — refresh every live invoice
      // on this PO, not just pending ones, so an invoice approved before the GRN
      // (mismatch overridden by finance) doesn't keep a stale "mismatch" tag
      const live = await db.prepare(`SELECT * FROM invoices WHERE po_id = ? AND status NOT IN ('rejected','cancelled')`).all(grn.po_id);
      for (const inv of live) {
        const match = await computeMatch(grn.po_id, inv.subtotal, inv.id);
        await db.prepare('UPDATE invoices SET match_status = ?, match_notes = ? WHERE id = ?').run(match.status, match.notes, inv.id);
      }
      // inventory module (future): this is where an approved GRN will post
      // stock_ledger receipts for po_items that reference an items-master row.
    });
    audit(req.user.id, 'approve', 'grn', grn.id, grn.grn_number);
    res.json({ ok: true });
  }));

  app.post('/api/grns/:id/reject', requireAuth, requireRole('approver'), wrap(async (req, res) => {
    const grn = await db.prepare('SELECT * FROM grns WHERE id = ?').get(req.params.id);
    if (!grn) return res.status(404).json({ error: 'GRN not found' });
    if (grn.status !== 'pending') throw new Error(`Cannot reject a GRN with status "${grn.status}"`);
    const reason = (req.body.reason || '').trim();
    await db.prepare(`UPDATE grns SET status = 'rejected', approved_by = ?, approved_at = to_char(now(), 'YYYY-MM-DD HH24:MI:SS'),
                notes = COALESCE(notes || ' — ', '') || 'Rejected: ' || ? WHERE id = ?`)
      .run(req.user.id, reason || 'no reason given', grn.id);
    audit(req.user.id, 'reject', 'grn', grn.id, grn.grn_number);
    res.json({ ok: true });
  }));
};
