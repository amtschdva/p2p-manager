// Core: user management, departments, approval matrix, branding, mail outbox.
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const { db, audit, DATA_DIR } = require('../db');
const approvals = require('../approvals');
const { requireAuth, requireRole, wrap, checkPassword } = require('../context');

const BRANDING_DIR = path.join(DATA_DIR, 'branding');
fs.mkdirSync(BRANDING_DIR, { recursive: true });
const LOGO_EXTS = ['.png', '.jpg', '.jpeg'];
const findLogo = () => LOGO_EXTS.map((e) => path.join(BRANDING_DIR, 'logo' + e)).find((f) => fs.existsSync(f));

// public: both portals show the logo when present (also used by vendor-server.js)
function logoHandler(req, res) {
  const file = findLogo();
  if (!file) return res.status(404).end();
  res.set('Cache-Control', 'no-cache');
  res.sendFile(file);
}

const logoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = LOGO_EXTS.includes(path.extname(file.originalname).toLowerCase());
    cb(ok ? null : new Error('Logo must be a PNG or JPG up to 2 MB'), ok);
  },
});

module.exports = function register(app) {
  // ---------- users (admin) ----------
  app.get('/api/users', requireAuth, requireRole('admin'), async (req, res) => {
    res.json(await db.prepare(`
      SELECT u.id, u.username, u.full_name, u.email, u.role, u.department_id, d.name AS department_name,
             u.active, u.totp_enabled, u.created_at
      FROM users u LEFT JOIN departments d ON d.id = u.department_id ORDER BY u.id`).all());
  });

  app.post('/api/users', requireAuth, requireRole('admin'), wrap(async (req, res) => {
    const { username, password, full_name, email, role, department_id } = req.body;
    if (!username || !password || !full_name || !role) throw new Error('username, password, full_name and role are required');
    checkPassword(password);
    const id = (await db.prepare('INSERT INTO users (username, password_hash, full_name, email, role, department_id) VALUES (?,?,?,?,?,?)')
      .run(username.trim().toLowerCase(), bcrypt.hashSync(password, 10), full_name, email || null, role, Number(department_id) || null)).lastInsertRowid;
    audit(req.user.id, 'create', 'user', id, username);
    res.status(201).json({ id });
  }));

  app.put('/api/users/:id', requireAuth, requireRole('admin'), wrap(async (req, res) => {
    const { full_name, email, role, active, password } = req.body;
    const id = Number(req.params.id);
    const existing = await db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ error: 'User not found' });
    if (id === req.user.id && active === 0) throw new Error('You cannot deactivate your own account');
    await db.prepare('UPDATE users SET full_name = ?, email = ?, role = ?, department_id = ?, active = ? WHERE id = ?')
      .run(full_name ?? existing.full_name, email ?? existing.email, role ?? existing.role,
           req.body.department_id !== undefined ? (Number(req.body.department_id) || null) : existing.department_id,
           active !== undefined ? (active ? 1 : 0) : existing.active, id);
    if (password) {
      checkPassword(password);
      await db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(password, 10), id);
    }
    if (req.body.reset_totp) {
      // lost-phone recovery: admin clears 2FA so the user can log in and re-enrol
      await db.prepare('UPDATE users SET totp_enabled = 0, totp_secret = NULL WHERE id = ?').run(id);
      audit(req.user.id, 'totp_reset', 'user', id, existing.username);
    }
    audit(req.user.id, 'update', 'user', id, null);
    res.json({ ok: true });
  }));

  // ---------- departments ----------
  app.get('/api/settings/departments', requireAuth, async (req, res) => {
    res.json(await db.prepare(`
      SELECT d.*, u.full_name AS head_name,
        (SELECT COUNT(*) FROM users WHERE department_id = d.id AND active = 1) AS member_count
      FROM departments d LEFT JOIN users u ON u.id = d.head_user_id ORDER BY d.name`).all());
  });

  app.post('/api/settings/departments', requireAuth, requireRole('admin'), wrap(async (req, res) => {
    const { name, head_user_id } = req.body;
    if (!name || !name.trim()) throw new Error('Department name is required');
    const id = (await db.prepare('INSERT INTO departments (name, head_user_id) VALUES (?,?)')
      .run(name.trim(), Number(head_user_id) || null)).lastInsertRowid;
    audit(req.user.id, 'create', 'department', id, name.trim());
    res.status(201).json({ id });
  }));

  app.put('/api/settings/departments/:id', requireAuth, requireRole('admin'), wrap(async (req, res) => {
    const d = await db.prepare('SELECT * FROM departments WHERE id = ?').get(req.params.id);
    if (!d) return res.status(404).json({ error: 'Department not found' });
    // default_cost_centre/default_sub_location pre-fill the invoice-approval
    // dropdowns for this department's invoices (finance can still override per invoice)
    await db.prepare(`UPDATE departments SET name = ?, head_user_id = ?, deputy_user_id = ?, active = ?,
                default_cost_centre = ?, default_sub_location = ? WHERE id = ?`)
      .run(req.body.name ?? d.name,
           req.body.head_user_id !== undefined ? (Number(req.body.head_user_id) || null) : d.head_user_id,
           req.body.deputy_user_id !== undefined ? (Number(req.body.deputy_user_id) || null) : d.deputy_user_id,
           req.body.active !== undefined ? (req.body.active ? 1 : 0) : d.active,
           req.body.default_cost_centre !== undefined ? ((req.body.default_cost_centre || '').trim() || null) : d.default_cost_centre,
           req.body.default_sub_location !== undefined ? ((req.body.default_sub_location || '').trim() || null) : d.default_sub_location,
           d.id);
    audit(req.user.id, 'update', 'department', d.id, d.name);
    res.json({ ok: true });
  }));

  // ---------- approval matrix ----------
  app.get('/api/settings/approval-rules', requireAuth, requireRole('admin'), async (req, res) => {
    res.json(await db.prepare(`
      SELECT r.*, d.name AS department_name FROM approval_rules r
      LEFT JOIN departments d ON d.id = r.department_id
      WHERE r.active = 1
      ORDER BY r.doc_type, COALESCE(r.department_id, 0), r.min_amount, r.seq`).all());
  });

  app.post('/api/settings/approval-rules', requireAuth, requireRole('admin'), wrap(async (req, res) => {
    const b = req.body;
    if (!['pr', 'invoice'].includes(b.doc_type)) throw new Error('doc_type must be pr or invoice');
    if (!['department_head', 'role', 'user'].includes(b.approver_kind)) throw new Error('Invalid approver kind');
    if (b.approver_kind === 'role' && !['admin', 'procurement', 'finance', 'approver', 'requester'].includes(b.approver_ref)) {
      throw new Error('approver_ref must be a valid role');
    }
    if (b.approver_kind === 'user' && !await db.prepare('SELECT id FROM users WHERE id = ?').get(Number(b.approver_ref))) {
      throw new Error('approver_ref must be an existing user id');
    }
    const seq = Number(b.seq) || 1;
    if (!(seq >= 1 && seq <= 5)) throw new Error('Level must be between 1 and 5');
    const newMin = Number(b.min_amount) || 0;
    const newMax = b.max_amount === '' || b.max_amount === undefined || b.max_amount === null ? null : Number(b.max_amount);
    if (newMax !== null && newMax < newMin) throw new Error('"To" amount must be greater than the "From" amount');
    // bands for the same document/department/level must not overlap — a document
    // must always match exactly one band per level
    const siblings = await db.prepare(`
      SELECT * FROM approval_rules
      WHERE doc_type = ? AND active = 1 AND seq = ?
        AND ((department_id IS NULL AND CAST(? AS INTEGER) IS NULL) OR department_id = ?)`)
      .all(b.doc_type, seq, Number(b.department_id) || null, Number(b.department_id) || null);
    for (const r of siblings) {
      const rMax = r.max_amount === null ? Infinity : r.max_amount;
      const nMax = newMax === null ? Infinity : newMax;
      if (newMin <= rMax && r.min_amount <= nMax) {
        throw new Error(`Overlaps an existing level-${seq} band (₹${r.min_amount} – ${r.max_amount === null ? 'no limit' : '₹' + r.max_amount}). Bands must not overlap.`);
      }
    }
    const id = (await db.prepare(`INSERT INTO approval_rules (doc_type, department_id, min_amount, max_amount, seq, approver_kind, approver_ref)
      VALUES (?,?,?,?,?,?,?)`)
      .run(b.doc_type, Number(b.department_id) || null, newMin, newMax,
           seq, b.approver_kind, b.approver_kind === 'department_head' ? null : String(b.approver_ref))).lastInsertRowid;
    audit(req.user.id, 'create', 'approval_rule', id, `${b.doc_type} L${seq}`);
    res.status(201).json({ id });
  }));

  app.delete('/api/settings/approval-rules/:id', requireAuth, requireRole('admin'), wrap(async (req, res) => {
    // soft delete — chains already snapshotted onto documents are unaffected
    await db.prepare('UPDATE approval_rules SET active = 0 WHERE id = ?').run(req.params.id);
    audit(req.user.id, 'delete', 'approval_rule', Number(req.params.id), null);
    res.json({ ok: true });
  }));

  // "who will approve this?" — used by the PR/invoice forms to show the chain up-front
  app.get('/api/approvals/preview', requireAuth, wrap(async (req, res) => {
    const docType = req.query.doc_type === 'invoice' ? 'invoice' : 'pr';
    const departmentId = Number(req.query.department_id) || null;
    const amount = Number(req.query.amount) || 0;
    res.json(await approvals.previewChain(docType, departmentId, amount));
  }));

  // ---------- company logo (branding) ----------
  app.get('/logo', logoHandler);

  app.post('/api/settings/logo', requireAuth, requireRole('admin'), async (req, res) => {
    logoUpload.single('logo')(req, res, async (err) => {
      try {
        if (err) throw err;
        if (!req.file) throw new Error('Choose a PNG or JPG file');
        const head = req.file.buffer.subarray(0, 8);
        const isPng = head.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
        const isJpg = head.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]));
        if (!isPng && !isJpg) throw new Error('The file does not look like a valid PNG or JPG image');
        for (const e of LOGO_EXTS) fs.rmSync(path.join(BRANDING_DIR, 'logo' + e), { force: true });
        fs.writeFileSync(path.join(BRANDING_DIR, 'logo' + (isPng ? '.png' : '.jpg')), req.file.buffer);
        audit(req.user.id, 'update', 'branding', null, 'logo uploaded');
        res.json({ ok: true });
      } catch (e) {
        res.status(400).json({ error: e.message || 'Upload failed' });
      }
    });
  });

  app.delete('/api/settings/logo', requireAuth, requireRole('admin'), wrap(async (req, res) => {
    for (const e of LOGO_EXTS) fs.rmSync(path.join(BRANDING_DIR, 'logo' + e), { force: true });
    audit(req.user.id, 'update', 'branding', null, 'logo removed');
    res.json({ ok: true });
  }));

  // mail outbox (admin) — see what was sent / would have been sent
  app.get('/api/settings/outbox', requireAuth, requireRole('admin'), async (req, res) => {
    res.json(await db.prepare('SELECT * FROM mail_outbox ORDER BY id DESC LIMIT 100').all());
  });
};

module.exports.logoHandler = logoHandler;
