// Dynamic approval matrix engine (async / Postgres).
//
// Rules (approval_rules) define per doc type, optionally per department and
// amount band, a sequence of approver levels: department_head | role | user.
// When a document is created, the matching chain is snapshotted into
// doc_approvals; approvers act on the lowest pending level in order.
const { db } = require('./db');

// Most specific match wins: department-specific rules beat "any department"
// rules; the amount must fall inside the rule's band.
async function buildChain(docType, departmentId, amount) {
  const rules = await db.prepare(`
    SELECT * FROM approval_rules
    WHERE doc_type = ? AND active = 1
      AND (department_id IS NULL OR department_id = ?)
      AND min_amount <= ? AND (max_amount IS NULL OR max_amount >= ?)
    ORDER BY seq`).all(docType, departmentId || -1, amount, amount);
  const deptRules = rules.filter((r) => r.department_id);
  const chosen = deptRules.length ? deptRules : rules.filter((r) => !r.department_id);
  const steps = [];
  for (const r of chosen) {
    // a department-head level is skipped when it cannot be resolved (document
    // has no department, or the department has no head) so chains never stall
    if (r.approver_kind === 'department_head') {
      const d = departmentId
        ? await db.prepare('SELECT head_user_id, deputy_user_id FROM departments WHERE id = ? AND active = 1').get(departmentId)
        : null;
      if (!d || (!d.head_user_id && !d.deputy_user_id)) continue;
    }
    steps.push({ seq: r.seq, kind: r.approver_kind, ref: r.approver_ref });
  }
  if (steps.length) return steps;
  // sensible fallbacks when no rule matches or every level was skipped
  return [{ seq: 1, kind: 'role', ref: docType === 'invoice' ? 'finance' : 'approver' }];
}

async function createApprovals(docType, docId, departmentId, amount) {
  const ins = db.prepare(`INSERT INTO doc_approvals (doc_type, doc_id, seq, approver_kind, approver_ref)
    VALUES (?,?,?,?,?)`);
  for (const step of await buildChain(docType, departmentId, amount)) {
    await ins.run(docType, docId, step.seq, step.kind, step.ref);
  }
}

async function approverLabel(kind, ref, departmentId) {
  if (kind === 'department_head') {
    const d = departmentId ? await db.prepare(
      `SELECT d.name, u.full_name, du.full_name AS deputy_name
       FROM departments d LEFT JOIN users u ON u.id = d.head_user_id
       LEFT JOIN users du ON du.id = d.deputy_user_id WHERE d.id = ?`).get(departmentId) : null;
    if (!d) return 'Department head';
    const who = [d.full_name, d.deputy_name && `deputy ${d.deputy_name}`].filter(Boolean).join(' or ');
    return `Head of ${d.name}${who ? ` (${who})` : ''}`;
  }
  if (kind === 'role') return `Role: ${ref}`;
  const u = await db.prepare('SELECT full_name FROM users WHERE id = ?').get(Number(ref));
  return u ? u.full_name : `User #${ref}`;
}

// chain with resolved labels + actor names, for detail views
async function getChain(docType, docId, departmentId) {
  const rows = await db.prepare(`
    SELECT da.*, u.full_name AS acted_by_name
    FROM doc_approvals da LEFT JOIN users u ON u.id = da.acted_by
    WHERE da.doc_type = ? AND da.doc_id = ? ORDER BY da.seq`).all(docType, docId);
  const out = [];
  for (const s of rows) {
    out.push({ ...s, label: await approverLabel(s.approver_kind, s.approver_ref, departmentId) });
  }
  return out;
}

function currentStep(docType, docId) {
  return db.prepare(`
    SELECT * FROM doc_approvals WHERE doc_type = ? AND doc_id = ? AND status = 'pending'
    ORDER BY seq LIMIT 1`).get(docType, docId);
}

async function canAct(user, step, departmentId, creatorId = null) {
  if (!step) return false;
  if (user.role === 'admin') return true; // admin can always unblock a chain
  // segregation of duties: whoever created the document cannot approve any of
  // its levels, regardless of their position in the chain
  if (creatorId && user.id === creatorId) return false;
  if (step.approver_kind === 'department_head') {
    if (!departmentId) return false;
    const d = await db.prepare('SELECT head_user_id, deputy_user_id FROM departments WHERE id = ?').get(departmentId);
    return !!d && (d.head_user_id === user.id || d.deputy_user_id === user.id);
  }
  if (step.approver_kind === 'role') return user.role === step.approver_ref;
  return user.id === Number(step.approver_ref);
}

/**
 * Approve or reject the current pending step.
 * Returns { finished, rejected, step } — finished=true when the whole chain is approved.
 */
async function act(docType, docId, user, approve, comment, departmentId, creatorId = null) {
  const step = await currentStep(docType, docId);
  if (!step) throw new Error('Nothing is pending approval on this document');
  if (creatorId && user.id === creatorId && user.role !== 'admin') {
    throw new Error('Segregation of duties: you cannot approve a document you created');
  }
  if (!(await canAct(user, step, departmentId, user.role === 'admin' ? null : creatorId))) {
    throw new Error(`This step is awaiting: ${await approverLabel(step.approver_kind, step.approver_ref, departmentId)}`);
  }
  await db.prepare(`UPDATE doc_approvals SET status = ?, acted_by = ?, acted_at = to_char(now(), 'YYYY-MM-DD HH24:MI:SS'), comment = ? WHERE id = ?`)
    .run(approve ? 'approved' : 'rejected', user.id, comment || null, step.id);
  return { finished: approve && !(await currentStep(docType, docId)), rejected: !approve, step };
}

// "who will approve this?" — resolved labels for a hypothetical document
async function previewChain(docType, departmentId, amount) {
  const chain = await buildChain(docType, departmentId, amount);
  const out = [];
  for (const c of chain) out.push({ seq: c.seq, label: await approverLabel(c.kind, c.ref, departmentId) });
  return out;
}

module.exports = { buildChain, createApprovals, getChain, currentStep, canAct, act, approverLabel, previewChain };
