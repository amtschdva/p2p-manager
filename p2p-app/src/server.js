const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { authenticator } = require('otplib');
const QRCode = require('qrcode');
const ExcelJS = require('exceljs');
const { db, init, nextNumber, audit } = require('./db');
const { seed } = require('./seed');
const { postInvoiceBookingJE, postPaymentJE, postDepositJE, r2 } = require('./journal');
const { GST_STATES, nameForCode } = require('./lib/gst-states');
const approvals = require('./approvals');
const { sendMail, usersByRole, userEmail, stepEmails, vendorEmails } = require('./mailer');

authenticator.options = { window: 1 }; // tolerate ±30s clock drift

const app = express();
const PORT = process.env.PORT || 9138;
const PROD = process.env.NODE_ENV === 'production';
if (PROD && !process.env.JWT_SECRET) {
  console.error('FATAL: JWT_SECRET must be set in production (e.g. openssl rand -hex 32)');
  process.exit(1);
}
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
const TOKEN_TTL = '8h';

// behind a reverse proxy (Traefik) the client IP arrives in X-Forwarded-For
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      // 'unsafe-inline' is required by the inline event handlers in the SPA; Chart.js comes from jsdelivr
      scriptSrc: ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net'],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
      // helmet adds upgrade-insecure-requests by default, which forces HTTPS and
      // breaks plain-HTTP localhost testing (Safari enforces it strictly).
      // In production everything is behind Traefik TLS, where it is a no-op anyway.
      ...(PROD ? {} : { upgradeInsecureRequests: null }),
    },
  },
  // HSTS only makes sense once served over HTTPS; Traefik terminates TLS
  strictTransportSecurity: PROD ? { maxAge: 15552000 } : false,
}));

// throttle credential endpoints against brute force / bulk fake registrations
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, limit: 10,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many login attempts — try again in 15 minutes' },
});
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, limit: 5,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many registrations from this address — try again later' },
});

const fmtInr = (n) => '₹' + Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// password policy for every newly set password
function checkPassword(pw) {
  if (!pw || pw.length < 8 || !/[a-zA-Z]/.test(pw) || !/[0-9]/.test(pw)) {
    throw new Error('Password must be at least 8 characters and contain both letters and numbers');
  }
}

const UPLOAD_DIR = path.join(require('./db').DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) =>
      cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${path.extname(file.originalname).toLowerCase()}`),
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = ['.pdf', '.png', '.jpg', '.jpeg'].includes(path.extname(file.originalname).toLowerCase());
    cb(ok ? null : new Error('Only PDF, PNG or JPG files up to 5 MB are allowed'), ok);
  },
});

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// ---------- auth middleware ----------
function bearerToken(req) {
  const header = req.headers.authorization || '';
  return header.startsWith('Bearer ') ? header.slice(7) : null;
}

async function requireAuth(req, res, next) {
  const token = bearerToken(req);
  if (!token) return res.status(401).json({ error: 'Authentication required' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    // only fully authenticated staff sessions — not vendor tokens, not TOTP-pending temp tokens
    if (payload.kind !== 'staff') return res.status(403).json({ error: 'Not a staff session' });
    const user = await db.prepare('SELECT id, username, full_name, role, department_id, active, totp_enabled FROM users WHERE id = ?').get(payload.sub);
    if (!user || !user.active) return res.status(401).json({ error: 'Account inactive' });
    req.user = user;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// vendor-portal auth: token must carry kind:'vendor'
async function requireVendorAuth(req, res, next) {
  const token = bearerToken(req);
  if (!token) return res.status(401).json({ error: 'Authentication required' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.kind !== 'vendor') return res.status(403).json({ error: 'Not a vendor account' });
    const vu = await db.prepare(`
      SELECT vu.id, vu.email, vu.full_name, vu.active, vu.vendor_id, v.name AS vendor_name, v.status AS vendor_status, v.verified
      FROM vendor_users vu JOIN vendors v ON v.id = vu.vendor_id WHERE vu.id = ?`).get(payload.sub);
    if (!vu || !vu.active) return res.status(401).json({ error: 'Account inactive' });
    req.vendorUser = vu;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// role helper: admin always allowed
function requireRole(...roles) {
  return (req, res, next) => {
    if (req.user.role === 'admin' || roles.includes(req.user.role)) return next();
    return res.status(403).json({ error: `Requires role: ${roles.join(' or ')}` });
  };
}

const wrap = (fn) => async (req, res) => {
  try { await fn(req, res); }
  catch (e) {
    console.error(e);
    res.status(400).json({ error: e.message || 'Request failed' });
  }
};

// ---------- auth ----------
app.post('/api/auth/login', loginLimiter, wrap(async (req, res) => {
  const { username, password } = req.body || {};
  const user = await db.prepare('SELECT * FROM users WHERE username = ?').get((username || '').trim().toLowerCase());
  if (!user || !bcrypt.compareSync(password || '', user.password_hash)) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  if (!user.active) return res.status(401).json({ error: 'Account is deactivated' });
  if (user.totp_enabled) {
    // password OK — second factor required before a real session is issued
    const tempToken = jwt.sign({ sub: user.id, kind: 'totp-pending' }, JWT_SECRET, { expiresIn: '5m' });
    return res.json({ totp_required: true, temp_token: tempToken });
  }
  const token = jwt.sign({ sub: user.id, role: user.role, kind: 'staff' }, JWT_SECRET, { expiresIn: TOKEN_TTL });
  audit(user.id, 'login', 'user', user.id, null);
  res.json({ token, user: { id: user.id, username: user.username, full_name: user.full_name, role: user.role, department_id: user.department_id } });
}));

// second login step: exchange temp token + authenticator code for a session
app.post('/api/auth/totp/verify', loginLimiter, wrap(async (req, res) => {
  const { temp_token, code } = req.body || {};
  let payload;
  try { payload = jwt.verify(temp_token || '', JWT_SECRET); }
  catch { return res.status(401).json({ error: 'Login expired — enter your password again' }); }
  if (payload.kind !== 'totp-pending') return res.status(401).json({ error: 'Invalid login state' });
  const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(payload.sub);
  if (!user || !user.active || !user.totp_enabled) return res.status(401).json({ error: 'Account inactive' });
  if (!authenticator.verify({ token: String(code || '').trim(), secret: user.totp_secret })) {
    return res.status(401).json({ error: 'Incorrect authenticator code' });
  }
  const token = jwt.sign({ sub: user.id, role: user.role, kind: 'staff' }, JWT_SECRET, { expiresIn: TOKEN_TTL });
  audit(user.id, 'login', 'user', user.id, '2fa');
  res.json({ token, user: { id: user.id, username: user.username, full_name: user.full_name, role: user.role, department_id: user.department_id } });
}));

// ---------- two-factor management (staff) ----------
app.post('/api/auth/totp/setup', requireAuth, wrap(async (req, res) => {
  const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (user.totp_enabled) throw new Error('Two-factor auth is already enabled — disable it first to re-enrol');
  const secret = authenticator.generateSecret();
  await db.prepare('UPDATE users SET totp_secret = ? WHERE id = ?').run(secret, user.id);
  const otpauth = authenticator.keyuri(user.username, 'P2P Manager', secret);
  const qr = await QRCode.toDataURL(otpauth, { margin: 1, width: 220 });
  res.json({ secret, otpauth, qr });
}));

app.post('/api/auth/totp/enable', requireAuth, wrap(async (req, res) => {
  const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (user.totp_enabled) throw new Error('Two-factor auth is already enabled');
  if (!user.totp_secret) throw new Error('Run setup first');
  if (!authenticator.verify({ token: String(req.body.code || '').trim(), secret: user.totp_secret })) {
    throw new Error('Incorrect code — scan the QR again and enter the current 6-digit code');
  }
  await db.prepare('UPDATE users SET totp_enabled = 1 WHERE id = ?').run(user.id);
  audit(user.id, 'totp_enable', 'user', user.id, null);
  res.json({ ok: true });
}));

app.post('/api/auth/totp/disable', requireAuth, wrap(async (req, res) => {
  const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user.totp_enabled) throw new Error('Two-factor auth is not enabled');
  if (!bcrypt.compareSync(req.body.password || '', user.password_hash)) throw new Error('Password is incorrect');
  if (!authenticator.verify({ token: String(req.body.code || '').trim(), secret: user.totp_secret })) {
    throw new Error('Incorrect authenticator code');
  }
  await db.prepare('UPDATE users SET totp_enabled = 0, totp_secret = NULL WHERE id = ?').run(user.id);
  audit(user.id, 'totp_disable', 'user', user.id, null);
  res.json({ ok: true });
}));

app.get('/api/auth/me', requireAuth, (req, res) => res.json(req.user));

app.post('/api/auth/change-password', requireAuth, wrap(async (req, res) => {
  const { current_password, new_password } = req.body || {};
  checkPassword(new_password);
  const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!bcrypt.compareSync(current_password || '', user.password_hash)) throw new Error('Current password is incorrect');
  await db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(new_password, 10), req.user.id);
  audit(req.user.id, 'change_password', 'user', req.user.id, null);
  res.json({ ok: true });
}));

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

// ---------- vendors ----------
const VENDOR_DOCS_DIR = path.join(require('./db').DATA_DIR, 'vendor-docs');
fs.mkdirSync(VENDOR_DOCS_DIR, { recursive: true });
const VENDOR_DOC_TYPES = ['pan', 'gstin', 'cancelled_cheque', 'msme', 'other'];
// domestic vendors: PAN + cancelled cheque always; GSTIN certificate only when
// the vendor is GST-registered (has a GSTIN on the master). MSME stays optional.
const requiredVendorDocs = (vendor) => {
  if (vendor.vendor_type === 'overseas') return [];
  const req = ['pan', 'cancelled_cheque'];
  if (vendor.gstin) req.push('gstin');
  return req;
};

const vendorDocUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = ['.pdf', '.png', '.jpg', '.jpeg'].includes(path.extname(file.originalname).toLowerCase());
    cb(ok ? null : new Error('Documents must be PDF, PNG or JPG up to 5 MB'), ok);
  },
});

// Lower/nil-TDS deduction certificates live in their own upload directory,
// same PDF/PNG/JPG-only pattern as vendor KYC documents.
const TDS_CERT_DIR = path.join(require('./db').DATA_DIR, 'vendor-tds-certs');
fs.mkdirSync(TDS_CERT_DIR, { recursive: true });
const tdsCertUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = ['.pdf', '.png', '.jpg', '.jpeg'].includes(path.extname(file.originalname).toLowerCase());
    cb(ok ? null : new Error('Certificate must be PDF, PNG or JPG up to 5 MB'), ok);
  },
});

async function saveVendorDocument(vendorId, docType, file, staffUserId, vendorUserId) {
  if (!VENDOR_DOC_TYPES.includes(docType)) throw new Error(`doc_type must be one of: ${VENDOR_DOC_TYPES.join(', ')}`);
  const head = file.buffer.subarray(0, 8);
  const isPdf = head.subarray(0, 4).equals(Buffer.from('%PDF'));
  const isPng = head.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const isJpg = head.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]));
  if (!isPdf && !isPng && !isJpg) throw new Error('The file does not look like a valid PDF, PNG or JPG');
  const dir = path.join(VENDOR_DOCS_DIR, String(vendorId));
  fs.mkdirSync(dir, { recursive: true });
  const filename = `${docType}-${Date.now()}${isPdf ? '.pdf' : isPng ? '.png' : '.jpg'}`;
  fs.writeFileSync(path.join(dir, filename), file.buffer);
  // one live document per type: replacing removes the previous file
  const old = await db.prepare('SELECT * FROM vendor_documents WHERE vendor_id = ? AND doc_type = ?').get(vendorId, docType);
  if (old) {
    fs.rmSync(path.join(VENDOR_DOCS_DIR, old.file_path), { force: true });
    await db.prepare('DELETE FROM vendor_documents WHERE id = ?').run(old.id);
  }
  return (await db.prepare(`INSERT INTO vendor_documents (vendor_id, doc_type, file_path, file_name, uploaded_by, uploaded_by_vendor_user)
    VALUES (?,?,?,?,?,?)`)
    .run(vendorId, docType, `${vendorId}/${filename}`, file.originalname, staffUserId || null, vendorUserId || null)).lastInsertRowid;
}

const vendorDocsFor = async (vendorId) => await db.prepare(`
  SELECT vd.*, u.full_name AS uploaded_by_name, vu.full_name AS uploaded_by_vendor_name
  FROM vendor_documents vd
  LEFT JOIN users u ON u.id = vd.uploaded_by
  LEFT JOIN vendor_users vu ON vu.id = vd.uploaded_by_vendor_user
  WHERE vd.vendor_id = ? ORDER BY vd.doc_type`).all(vendorId);

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
    (code, name, vendor_type, contact_person, email, phone, address, gstin, pan, tax_category, bank_name, bank_account, ifsc, payment_terms, payment_terms_days, ap_account_code, currency, status, verified)
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

// ---------- lower/nil TDS deduction certificates ----------
// A certificate's lower rate applies only up to its threshold_amount (the
// certificate's authorised limit, if any) — once invoices booked against it
// reach that limit, or its validity window closes, whichever is sooner, the
// standard section rate applies again.
app.get('/api/vendors/:id/tds-certificates', requireAuth, wrap(async (req, res) => {
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
// Domestic vendors need PAN + GSTIN certificate + cancelled cheque on file first.
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

// ---------- company logo (branding) ----------
const BRANDING_DIR = path.join(require('./db').DATA_DIR, 'branding');
fs.mkdirSync(BRANDING_DIR, { recursive: true });
const LOGO_EXTS = ['.png', '.jpg', '.jpeg'];
const findLogo = () => LOGO_EXTS.map((e) => path.join(BRANDING_DIR, 'logo' + e)).find((f) => fs.existsSync(f));

// public: both portals show the logo when present
app.get('/logo', (req, res) => {
  const file = findLogo();
  if (!file) return res.status(404).end();
  res.set('Cache-Control', 'no-cache');
  res.sendFile(file);
});

const logoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = LOGO_EXTS.includes(path.extname(file.originalname).toLowerCase());
    cb(ok ? null : new Error('Logo must be a PNG or JPG up to 2 MB'), ok);
  },
});

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

// ---------- tax masters ----------
// combined lookup used by invoice/PO/approval forms
app.get('/api/meta/tax', requireAuth, async (req, res) => {
  const labelRows = await db.prepare(`SELECT key, value FROM app_settings WHERE key LIKE 'custom_field_%_label'`).all();
  const byKey = Object.fromEntries(labelRows.map((r) => [r.key, r.value]));
  const custom_field_labels = {};
  for (let i = 1; i <= 5; i++) custom_field_labels[`custom_field_${i}`] = byKey[`custom_field_${i}_label`] || `Custom Field ${i}`;
  res.json({
    gstins: await db.prepare('SELECT * FROM company_gstins WHERE active = 1 ORDER BY id').all(),
    tds_sections: await db.prepare('SELECT * FROM tds_sections WHERE active = 1 ORDER BY section, rate').all(),
    rcm_categories: await db.prepare('SELECT * FROM rcm_categories WHERE active = 1 ORDER BY id').all(),
    ap_account_codes: await db.prepare('SELECT * FROM ap_account_codes WHERE active = 1 ORDER BY code').all(),
    sub_locations: await db.prepare('SELECT * FROM sub_locations WHERE active = 1 ORDER BY code').all(),
    cost_centres: await db.prepare('SELECT * FROM cost_centres WHERE active = 1 ORDER BY code').all(),
    gst_states: GST_STATES,
    custom_field_labels,
    departments: await db.prepare(`
      SELECT d.*, u.full_name AS head_name FROM departments d
      LEFT JOIN users u ON u.id = d.head_user_id WHERE d.active = 1 ORDER BY d.name`).all(),
  });
});

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
  await db.prepare('UPDATE departments SET name = ?, head_user_id = ?, deputy_user_id = ?, default_cost_centre = ?, default_sub_location = ?, active = ? WHERE id = ?')
    .run(req.body.name ?? d.name,
         req.body.head_user_id !== undefined ? (Number(req.body.head_user_id) || null) : d.head_user_id,
         req.body.deputy_user_id !== undefined ? (Number(req.body.deputy_user_id) || null) : d.deputy_user_id,
         req.body.default_cost_centre !== undefined ? ((req.body.default_cost_centre || '').trim() || null) : d.default_cost_centre,
         req.body.default_sub_location !== undefined ? ((req.body.default_sub_location || '').trim() || null) : d.default_sub_location,
         req.body.active !== undefined ? (req.body.active ? 1 : 0) : d.active, d.id);
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

app.get('/api/settings/gstins', requireAuth, async (req, res) => {
  res.json(await db.prepare('SELECT * FROM company_gstins ORDER BY id').all());
});

// map this GSTIN's postings into an external accounting system (Tally/SUN/
// Dynamics/...) — optional, blank is fine until a client needs the export.
const GSTIN_GL_FIELDS = ['gst_payable_cgst_code', 'gst_payable_sgst_code', 'gst_payable_igst_code',
  'gst_input_cgst_code', 'gst_input_sgst_code', 'gst_input_igst_code', 'gst_rcm_payable_code', 'gst_rcm_input_code'];

app.post('/api/settings/gstins', requireAuth, requireRole('admin'), wrap(async (req, res) => {
  const { gstin, state_name, label } = req.body;
  if (!gstin || !/^[0-9]{2}[A-Z0-9]{13}$/i.test(gstin.trim())) throw new Error('GSTIN must be 15 characters starting with the 2-digit state code');
  if (!label) throw new Error('Label is required (e.g. "Bengaluru HO")');
  const g = gstin.trim().toUpperCase();
  const glVals = GSTIN_GL_FIELDS.map((f) => (req.body[f] || '').trim() || null);
  const id = (await db.prepare(`INSERT INTO company_gstins (gstin, state_code, state_name, label, ${GSTIN_GL_FIELDS.join(', ')})
    VALUES (?,?,?,?,${GSTIN_GL_FIELDS.map(() => '?').join(',')})`)
    .run(g, g.slice(0, 2), state_name || '', label, ...glVals)).lastInsertRowid;
  audit(req.user.id, 'create', 'company_gstin', id, g);
  res.status(201).json({ id });
}));

app.put('/api/settings/gstins/:id', requireAuth, requireRole('admin'), wrap(async (req, res) => {
  const g = await db.prepare('SELECT * FROM company_gstins WHERE id = ?').get(req.params.id);
  if (!g) return res.status(404).json({ error: 'Not found' });
  const glVals = GSTIN_GL_FIELDS.map((f) => (req.body[f] !== undefined ? ((req.body[f] || '').trim() || null) : g[f]));
  await db.prepare(`UPDATE company_gstins SET label = ?, state_name = ?, active = ?, ${GSTIN_GL_FIELDS.map((f) => `${f} = ?`).join(', ')} WHERE id = ?`)
    .run(req.body.label ?? g.label, req.body.state_name ?? g.state_name,
         req.body.active !== undefined ? (req.body.active ? 1 : 0) : g.active, ...glVals, g.id);
  audit(req.user.id, 'update', 'company_gstin', g.id, g.gstin);
  res.json({ ok: true });
}));

app.get('/api/settings/tds-sections', requireAuth, async (req, res) => {
  res.json(await db.prepare('SELECT * FROM tds_sections ORDER BY section, rate').all());
});

app.post('/api/settings/tds-sections', requireAuth, requireRole('admin'), wrap(async (req, res) => {
  const { section, description, rate, account_code } = req.body;
  if (!section || !description || !(Number(rate) >= 0)) throw new Error('Section, description and a rate are required');
  const id = (await db.prepare('INSERT INTO tds_sections (section, description, rate, account_code) VALUES (?,?,?,?)')
    .run(section.trim(), description.trim(), Number(rate), (account_code || '').trim() || null)).lastInsertRowid;
  audit(req.user.id, 'create', 'tds_section', id, section);
  res.status(201).json({ id });
}));

app.put('/api/settings/tds-sections/:id', requireAuth, requireRole('admin'), wrap(async (req, res) => {
  const s = await db.prepare('SELECT * FROM tds_sections WHERE id = ?').get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Not found' });
  await db.prepare('UPDATE tds_sections SET description = ?, rate = ?, account_code = ?, active = ? WHERE id = ?')
    .run(req.body.description ?? s.description, req.body.rate !== undefined ? Number(req.body.rate) : s.rate,
         req.body.account_code !== undefined ? ((req.body.account_code || '').trim() || null) : s.account_code,
         req.body.active !== undefined ? (req.body.active ? 1 : 0) : s.active, s.id);
  audit(req.user.id, 'update', 'tds_section', s.id, s.section);
  res.json({ ok: true });
}));

app.get('/api/settings/rcm-categories', requireAuth, async (req, res) => {
  res.json(await db.prepare('SELECT * FROM rcm_categories ORDER BY id').all());
});

app.post('/api/settings/rcm-categories', requireAuth, requireRole('admin'), wrap(async (req, res) => {
  if (!req.body.name) throw new Error('Name is required');
  const id = (await db.prepare('INSERT INTO rcm_categories (name, description) VALUES (?,?)')
    .run(req.body.name.trim(), req.body.description || null)).lastInsertRowid;
  audit(req.user.id, 'create', 'rcm_category', id, req.body.name);
  res.status(201).json({ id });
}));

// ---------- GL reference masters: AP account codes, sub-locations, cost centres ----------
// Same shape and pattern for all three — simple code+name lists that populate
// dropdowns elsewhere (vendor AP code, invoice approval's sub-location/cost-centre).
function registerCodeMaster(table, entity) {
  app.get(`/api/settings/${entity}`, requireAuth, async (req, res) => {
    res.json(await db.prepare(`SELECT * FROM ${table} ORDER BY code`).all());
  });
  app.post(`/api/settings/${entity}`, requireAuth, requireRole('admin'), wrap(async (req, res) => {
    const { code, name } = req.body;
    if (!code || !code.trim()) throw new Error('Code is required');
    if (!name || !name.trim()) throw new Error('Name is required');
    const id = (await db.prepare(`INSERT INTO ${table} (code, name) VALUES (?,?)`)
      .run(code.trim(), name.trim())).lastInsertRowid;
    audit(req.user.id, 'create', entity, id, code.trim());
    res.status(201).json({ id });
  }));
  app.put(`/api/settings/${entity}/:id`, requireAuth, requireRole('admin'), wrap(async (req, res) => {
    const row = await db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    await db.prepare(`UPDATE ${table} SET name = ?, active = ? WHERE id = ?`)
      .run(req.body.name ?? row.name, req.body.active !== undefined ? (req.body.active ? 1 : 0) : row.active, row.id);
    audit(req.user.id, 'update', entity, row.id, row.code);
    res.json({ ok: true });
  }));
}
registerCodeMaster('ap_account_codes', 'ap-account-codes');
registerCodeMaster('sub_locations', 'sub-locations');
registerCodeMaster('cost_centres', 'cost-centres');

// ---------- GL period lock (month-end close) ----------
// Everything up to and including the locked month is closed: no JE — invoice
// booking, payment, or deposit — may post into it (enforced in journal.js).
app.get('/api/settings/gl-lock', requireAuth, wrap(async (req, res) => {
  const row = await db.prepare(`SELECT value FROM app_settings WHERE key = 'gl_locked_through'`).get();
  res.json({ locked_through: (row && row.value) || null });
}));

app.put('/api/settings/gl-lock', requireAuth, requireRole('finance'), wrap(async (req, res) => {
  const value = (req.body.locked_through || '').trim();
  if (value && !/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) throw new Error('Locked-through period must be a valid month in YYYY-MM format');
  if (value) {
    await db.prepare(`INSERT INTO app_settings (key, value) VALUES ('gl_locked_through', ?)
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value RETURNING key`).run(value);
  } else {
    await db.prepare(`DELETE FROM app_settings WHERE key = 'gl_locked_through'`).run();
  }
  audit(req.user.id, 'update', 'gl_period_lock', null, value ? `books closed through ${value}` : 'lock removed');
  res.json({ ok: true, locked_through: value || null });
}));

// ---------- custom field labels (per-client rename of the 5 spare invoice fields) ----------
app.get('/api/settings/custom-field-labels', requireAuth, wrap(async (req, res) => {
  const rows = await db.prepare(`SELECT key, value FROM app_settings WHERE key LIKE 'custom_field_%_label'`).all();
  const byKey = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  const labels = {};
  for (let i = 1; i <= 5; i++) labels[`custom_field_${i}`] = byKey[`custom_field_${i}_label`] || `Custom Field ${i}`;
  res.json(labels);
}));

app.put('/api/settings/custom-field-labels', requireAuth, requireRole('admin'), wrap(async (req, res) => {
  for (let i = 1; i <= 5; i++) {
    const key = `custom_field_${i}`;
    if (req.body[key] === undefined) continue;
    const label = (req.body[key] || '').trim() || `Custom Field ${i}`;
    // app_settings has no "id" column — RETURNING key stops the .run() shim
    // from auto-appending "RETURNING id" (which every other table has)
    await db.prepare(`INSERT INTO app_settings (key, value) VALUES (?,?)
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value RETURNING key`).run(`${key}_label`, label);
  }
  audit(req.user.id, 'update', 'custom_field_labels', null, null);
  res.json({ ok: true });
}));

// ---------- purchase requisitions ----------
const PR_LIST_SQL = `
  SELECT p.*, u.full_name AS requester_name, a.full_name AS approver_name, d.name AS department_name,
    (SELECT COALESCE(SUM(quantity * est_unit_price), 0) FROM pr_items WHERE pr_id = p.id) AS estimated_total
  FROM prs p
  JOIN users u ON u.id = p.requester_id
  LEFT JOIN users a ON a.id = p.approver_id
  LEFT JOIN departments d ON d.id = p.department_id`;

// Department-level visibility for matrix documents (PRs and invoices).
// Returns null for users who may see everything: finance (they process every
// document anyway), admin, and procurement (a central function — they convert
// any department's PRs into POs and enter invoices on vendors' behalf).
// Everyone else sees documents belonging to: their own department, any
// department they head, and any department they're deputy of — so a deputy
// covering another department sees its documents, exactly like the approval
// matrix routes them.
async function visibleDeptIds(user) {
  if (['admin', 'finance', 'procurement'].includes(user.role)) return null;
  const rows = await db.prepare('SELECT id FROM departments WHERE head_user_id = ? OR deputy_user_id = ?').all(user.id, user.id);
  const ids = new Set(rows.map((r) => r.id));
  if (user.department_id) ids.add(user.department_id);
  return [...ids];
}

// a document is visible if its department is in scope, or the user created it
// themselves (a requester can always track their own submissions)
const canSeeDoc = (deptIds, doc, userId, creatorField) =>
  deptIds === null || (doc.department_id && deptIds.includes(doc.department_id)) || doc[creatorField] === userId;

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
  const prDeptIds = await visibleDeptIds(req.user);
  let mayViewPr = canSeeDoc(prDeptIds, pr, req.user.id, 'requester_id');
  if (!mayViewPr && pr.status === 'submitted') {
    const pendingStep = await approvals.currentStep('pr', pr.id);
    mayViewPr = !!pendingStep && await approvals.canAct(req.user, pendingStep, pr.department_id);
  }
  if (!mayViewPr) {
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
    const ins = db.prepare('INSERT INTO pr_items (pr_id, description, quantity, unit, est_unit_price) VALUES (?,?,?,?,?)');
    for (const it of items) await ins.run(prId, it.description, Number(it.quantity), it.unit || 'EA', Number(it.est_unit_price) || 0);
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
const PO_LIST_SQL = `
  SELECT po.*, v.name AS vendor_name, v.gstin AS vendor_gstin, v.vendor_type,
    u.full_name AS created_by_name, pr.pr_number,
    cg.label AS gstin_label, cg.gstin AS company_gstin, cg.state_code AS company_state_code,
    (SELECT COALESCE(SUM(quantity * unit_price), 0) FROM po_items WHERE po_id = po.id) AS total
  FROM pos po
  JOIN vendors v ON v.id = po.vendor_id
  JOIN users u ON u.id = po.created_by
  LEFT JOIN company_gstins cg ON cg.id = po.company_gstin_id
  LEFT JOIN prs pr ON pr.id = po.pr_id`;

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
  const gstin = await db.prepare('SELECT * FROM company_gstins WHERE id = ? AND active = 1').get(company_gstin_id);
  if (!gstin) throw new Error('Select the company GST registration this PO is procured under');
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
      .run(poNumber, pr_id || null, vendor_id, gstin.id, req.user.id, expected_date || null, notes || null)).lastInsertRowid;
    const ins = db.prepare('INSERT INTO po_items (po_id, description, quantity, unit, unit_price) VALUES (?,?,?,?,?)');
    for (const it of items) await ins.run(poId, it.description, Number(it.quantity), it.unit || 'EA', Number(it.unit_price) || 0);
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

// PO receipt status derived from APPROVED receipts only
async function refreshPoReceiptStatus(poId) {
  const po = await db.prepare('SELECT * FROM pos WHERE id = ?').get(poId);
  if (!po || ['closed', 'cancelled'].includes(po.status)) return;
  const agg = await db.prepare(`
    SELECT SUM(pi.quantity) AS ordered,
           COALESCE((SELECT SUM(gi.quantity_received) FROM grn_items gi
                     JOIN grns g ON g.id = gi.grn_id JOIN po_items p2 ON p2.id = gi.po_item_id
                     WHERE p2.po_id = ? AND g.status = 'approved'), 0) AS received
    FROM po_items pi WHERE pi.po_id = ?`).get(poId, poId);
  if (agg.received > 0) {
    await db.prepare('UPDATE pos SET status = ? WHERE id = ?')
      .run(agg.received >= agg.ordered ? 'received' : 'partially_received', poId);
  }
}

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

// ---------- invoices ----------
const INV_LIST_SQL = `
  SELECT i.*, v.name AS vendor_name, v.gstin AS vendor_gstin, v.vendor_type, po.po_number,
    cg.label AS gstin_label, cg.gstin AS company_gstin,
    dd.name AS department_name, dd.default_cost_centre AS department_default_cost_centre, dd.default_sub_location AS department_default_sub_location,
    rc.name AS rcm_category_name,
    je.je_number AS booking_je_number,
    COALESCE(u.full_name, vu.full_name || ' (vendor portal)') AS created_by_name,
    a.full_name AS approved_by_name,
    COALESCE((SELECT SUM(amount) FROM payments WHERE invoice_id = i.id AND status = 'released'), 0) AS paid_amount
  FROM invoices i
  JOIN vendors v ON v.id = i.vendor_id
  JOIN pos po ON po.id = i.po_id
  LEFT JOIN company_gstins cg ON cg.id = i.company_gstin_id
  LEFT JOIN departments dd ON dd.id = i.department_id
  LEFT JOIN rcm_categories rc ON rc.id = i.rcm_category_id
  LEFT JOIN journal_entries je ON je.id = i.booking_je_id
  LEFT JOIN users u ON u.id = i.created_by
  LEFT JOIN vendor_users vu ON vu.id = i.vendor_user_id
  LEFT JOIN users a ON a.id = i.approved_by`;

app.get('/api/invoices', requireAuth, wrap(async (req, res) => {
  const deptIds = await visibleDeptIds(req.user);
  const invoices = await db.prepare(`${INV_LIST_SQL} ORDER BY i.id DESC`).all();
  res.json(deptIds === null ? invoices : invoices.filter((i) => canSeeDoc(deptIds, i, req.user.id, 'created_by')));
}));

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
app.get('/api/invoices/:id/attachment', wrap(async (req, res) => {
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
}));

// 3-way match: PO value vs approved-GRN received value vs invoice subtotal (2% tolerance)
async function computeMatch(poId, invoiceSubtotal, excludeInvoiceId = null) {
  const rows = await db.prepare(`
    SELECT pi.quantity, pi.unit_price,
      COALESCE((SELECT SUM(gi.quantity_received) FROM grn_items gi JOIN grns g ON g.id = gi.grn_id
                WHERE gi.po_item_id = pi.id AND g.status = 'approved'), 0) AS received_qty
    FROM po_items pi WHERE pi.po_id = ?`).all(poId);
  const poValue = rows.reduce((s, r) => s + r.quantity * r.unit_price, 0);
  const grnValue = rows.reduce((s, r) => s + r.received_qty * r.unit_price, 0);
  const otherInvoiced = (await db.prepare(`
    SELECT COALESCE(SUM(subtotal),0) AS s FROM invoices
    WHERE po_id = ? AND status NOT IN ('rejected','cancelled') AND (CAST(? AS INTEGER) IS NULL OR id != ?)`)
    .get(poId, excludeInvoiceId, excludeInvoiceId)).s;
  const tolerance = Math.max(grnValue * 0.02, 1);
  const notes = [];
  let status = 'matched';
  if (grnValue <= 0) {
    status = 'mismatch';
    notes.push('No approved goods receipt against this PO yet');
  } else if (invoiceSubtotal + otherInvoiced > grnValue + tolerance) {
    status = 'mismatch';
    notes.push(`Invoiced value (₹${(invoiceSubtotal + otherInvoiced).toFixed(2)} incl. prior invoices) exceeds received value (₹${grnValue.toFixed(2)})`);
  }
  if (invoiceSubtotal > poValue + tolerance) {
    status = 'mismatch';
    notes.push(`Invoice subtotal exceeds total PO value (₹${poValue.toFixed(2)})`);
  }
  return { status, notes: notes.join('; ') || 'PO / GRN / invoice values agree within 2% tolerance' };
}

// shared GST/RCM validation for staff- and vendor-entered invoices
async function prepareInvoiceTax(po, vendor, body) {
  const sub = r2(Number(body.subtotal));
  if (!(sub > 0)) throw new Error('Subtotal must be greater than zero');
  const isOverseas = vendor.vendor_type === 'overseas';
  const rcm = isOverseas || body.rcm === 1 || body.rcm === '1' || body.rcm === true ? 1 : 0;
  let cgst = r2(Number(body.cgst_amount) || 0);
  let sgst = r2(Number(body.sgst_amount) || 0);
  let igst = r2(Number(body.igst_amount) || 0);
  if (cgst < 0 || sgst < 0 || igst < 0) throw new Error('GST amounts cannot be negative');
  let rcmCategoryId = null;
  if (rcm) {
    // RCM: vendor charges no GST; IGST is self-assessed and NOT payable to the vendor
    cgst = 0; sgst = 0;
    rcmCategoryId = Number(body.rcm_category_id) || null;
    if (isOverseas && !rcmCategoryId) {
      const imp = await db.prepare(`SELECT id FROM rcm_categories WHERE name = 'Import of services'`).get();
      rcmCategoryId = imp ? imp.id : null;
    }
    if (!rcmCategoryId) throw new Error('Select the RCM category');
  } else if ((cgst > 0 || sgst > 0) && igst > 0) {
    throw new Error('An invoice carries either CGST+SGST (intra-state) or IGST (inter-state), not both');
  }
  const tax = r2(cgst + sgst + igst);
  const total = rcm ? sub : r2(sub + tax);
  return { sub, cgst, sgst, igst, tax, total, rcm, rcmCategoryId,
    gstr2bStatus: rcm || isOverseas ? 'na' : 'pending' };
}

// due date auto-calculates from the invoice receipt date + the vendor's
// payment-terms days, unless the caller supplies an explicit due date
function prepareReceiptAndDueDate(vendor, body) {
  const receivedDate = body.received_date || body.invoice_date || null;
  let dueDate = body.due_date || null;
  if (!dueDate && receivedDate) {
    const days = Number(vendor.payment_terms_days) || 30;
    const d = new Date(receivedDate + 'T00:00:00Z');
    if (!Number.isNaN(d.getTime())) { d.setUTCDate(d.getUTCDate() + days); dueDate = d.toISOString().slice(0, 10); }
  }
  return { receivedDate, dueDate };
}

// Place of Supply / HSN-SAC / GL description — captured at submission, shared
// by staff and vendor-portal invoice entry. Place of Supply auto-derives from
// the vendor's GSTIN (first 2 digits) but stays editable; both it and the
// HSN/SAC code are compulsory once the vendor is GST-registered.
async function prepareInvoiceGlFields(vendor, body) {
  const isGstRegistered = !!vendor.gstin;
  let placeOfSupplyCode = (body.place_of_supply_code || '').trim().toUpperCase() || null;
  if (!placeOfSupplyCode && vendor.gstin) placeOfSupplyCode = vendor.gstin.slice(0, 2);
  let placeOfSupplyState = null;
  if (placeOfSupplyCode) {
    placeOfSupplyState = nameForCode(placeOfSupplyCode);
    if (!placeOfSupplyState) throw new Error(`"${placeOfSupplyCode}" is not a recognised GST state/UT code`);
  }
  const hsnSacCode = (body.hsn_sac_code || '').trim() || null;
  if (isGstRegistered) {
    if (!placeOfSupplyCode) throw new Error('Place of Supply is required for GST-registered vendors');
    if (!hsnSacCode) throw new Error('HSN/SAC Code is required for GST-registered vendors');
  }
  const glDescription = (body.gl_description || '').trim() || null;
  if (glDescription && glDescription.length > 50) throw new Error('Description must be 50 characters or fewer');
  return { placeOfSupplyCode, placeOfSupplyState, hsnSacCode, glDescription };
}

// Standard AP control: the same vendor invoice must never be recorded twice.
// Comparison ignores case and internal whitespace ("INV 001" == "inv001").
// Rejected/cancelled invoices don't block — a fixed resubmission is fine.
// Call inside the insert transaction, after nextNumber() (whose advisory lock
// serializes concurrent submissions), so two copies can't slip in together.
async function assertNotDuplicateInvoice(vendorId, vendorInvoiceRef) {
  const ref = (vendorInvoiceRef || '').trim();
  if (!ref) return; // internal entries without a vendor reference are exempt
  const dup = await db.prepare(`SELECT invoice_number FROM invoices
    WHERE vendor_id = ? AND status NOT IN ('rejected', 'cancelled')
      AND UPPER(REPLACE(COALESCE(vendor_invoice_ref, ''), ' ', '')) = UPPER(REPLACE(?, ' ', ''))`)
    .get(vendorId, ref);
  if (dup) throw new Error(`Duplicate invoice: this vendor's reference "${ref}" is already recorded on ${dup.invoice_number}`);
}

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
      const gstinId = Number(b.company_gstin_id) || po.company_gstin_id;
      if (!gstinId) throw new Error('Select the company GST registration for this invoice');
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
// level books the invoice (TDS section/rate chosen there, JE posted there).
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

  // TDS: section 'none' or empty → no deduction; otherwise rate applies on taxable value.
  // A lower/nil-deduction certificate valid on the invoice date can supply the rate
  // instead of the section's standard master rate (finance can still override).
  let tdsSection = (b.tds_section || '').trim();
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
  if (inv.rcm && b.rcm_igst !== undefined && b.rcm_igst !== '') {
    igst = r2(Number(b.rcm_igst));
    if (!(igst >= 0)) throw new Error('Self-assessed IGST cannot be negative');
  }

  // GL-classification dimensions — sub-location/cost-centre fall back to the
  // invoice's department defaults when finance doesn't pick one
  const dept = inv.department_id ? await db.prepare('SELECT * FROM departments WHERE id = ?').get(inv.department_id) : null;
  const subLocation = (b.sub_location || '').trim() || (dept && dept.default_sub_location) || null;
  const costCentre = (b.cost_centre || '').trim() || (dept && dept.default_cost_centre) || null;
  const programProductCode = (b.program_product_code || '').trim() || null;
  const glPeriod = (b.gl_period || '').trim() || inv.invoice_date.slice(0, 7);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(glPeriod)) throw new Error('GL period must be a valid month in YYYY-MM format');
  const customFields = [1, 2, 3, 4, 5].map((i) => (b[`custom_field_${i}`] || '').trim() || null);

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
    if (tdsSection && b.tds_certificate_id) {
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
    } else if (tdsSection) {
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
    const updated = await db.prepare('SELECT * FROM invoices WHERE id = ?').get(inv.id);
    const { jeId, jeNumber } = await postInvoiceBookingJE(updated, req.user.id);
    await db.prepare('UPDATE invoices SET booking_je_id = ? WHERE id = ?').run(jeId, inv.id);
    return { jeNumber, tdsAmount, netPayable: r2(updated.total - tdsAmount) };
  });
  audit(req.user.id, 'approve', 'invoice', inv.id,
    `${inv.invoice_number} (JE ${result.jeNumber})${tdsRateOverrideReason ? ` — TDS rate override to ${tdsRate}%: ${tdsRateOverrideReason}` : ''}`);
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

// ---------- payments (maker-checker) ----------
// A finance user PREPARES a payment (no accounting effect); a DIFFERENT finance
// user (or admin) RELEASES it — the JE, invoice status and vendor visibility
// all happen at release. Pending payments reserve the outstanding balance.
// payment releases are reserved for the head of the department named "Finance"
// (falls back to any other finance user when no such head is configured)
const financeHead = () => db.prepare(
  `SELECT head_user_id FROM departments WHERE lower(name) = 'finance' AND active = 1 AND head_user_id IS NOT NULL`).get();

const PAY_LIST_SQL = `
  SELECT p.*, i.invoice_number, i.total AS invoice_total, i.tds_amount, i.department_id, v.name AS vendor_name,
    v.bank_name, v.bank_account, v.ifsc,
    u.full_name AS created_by_name, ru.full_name AS released_by_name
  FROM payments p
  JOIN invoices i ON i.id = p.invoice_id
  JOIN vendors v ON v.id = i.vendor_id
  JOIN users u ON u.id = p.created_by
  LEFT JOIN users ru ON ru.id = p.released_by`;

app.get('/api/payments', requireAuth, wrap(async (req, res) => {
  // payments inherit the visibility of the invoice they settle — a payment
  // row reveals invoice amounts and vendor bank details
  const deptIds = await visibleDeptIds(req.user);
  const payments = await db.prepare(`${PAY_LIST_SQL} ORDER BY p.id DESC`).all();
  res.json(deptIds === null ? payments : payments.filter((p) => canSeeDoc(deptIds, p, req.user.id, 'created_by')));
}));

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
    const payment = await db.prepare('SELECT * FROM payments WHERE id = ?').get(p.id);
    const { jeId, jeNumber } = await postPaymentJE(payment, inv, req.user.id);
    await db.prepare('UPDATE payments SET je_id = ? WHERE id = ?').run(jeId, p.id);
    return { jeNumber };
  });
  audit(req.user.id, 'release', 'payment', p.id, `${p.payment_number} (JE ${result.jeNumber})`);
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

// "who will approve this?" — used by the PR/invoice forms to show the chain up-front
app.get('/api/approvals/preview', requireAuth, wrap(async (req, res) => {
  const docType = req.query.doc_type === 'invoice' ? 'invoice' : 'pr';
  const departmentId = Number(req.query.department_id) || null;
  const amount = Number(req.query.amount) || 0;
  res.json(await approvals.previewChain(docType, departmentId, amount));
}));

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
  const payHead = await financeHead();
  const canRelease = me.role === 'admin' || (payHead ? me.id === payHead.head_user_id : me.role === 'finance');
  const payments = canRelease
    ? (await db.prepare(`${PAY_LIST_SQL} WHERE p.status = 'pending_release' ORDER BY p.id`).all())
        .filter((p) => p.created_by !== me.id || me.role === 'admin')
        .map((p) => ({ id: p.id, number: p.payment_number, title: `${p.vendor_name} · ${p.invoice_number} · prepared by ${p.created_by_name}`, amount: p.amount, since: p.created_at }))
    : [];

  res.json({ prs, invoices, grns, vendors, payments,
    total: prs.length + invoices.length + grns.length + vendors.length + payments.length });
}));

// mail outbox (admin) — see what was sent / would have been sent
app.get('/api/settings/outbox', requireAuth, requireRole('admin'), async (req, res) => {
  res.json(await db.prepare('SELECT * FROM mail_outbox ORDER BY id DESC LIMIT 100').all());
});

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

// ---------- journal entries ----------
const JE_SQL = `
  SELECT je.*, u.full_name AS created_by_name
  FROM journal_entries je LEFT JOIN users u ON u.id = je.created_by`;

async function journalWithLines(where, params) {
  const entries = await db.prepare(`${JE_SQL} ${where} ORDER BY je.je_date DESC, je.id DESC LIMIT 500`).all(...params);
  const getLines = db.prepare(`
    SELECT jl.*, v.name AS vendor_name, cg.label AS gstin_label
    FROM journal_lines jl
    LEFT JOIN vendors v ON v.id = jl.vendor_id
    LEFT JOIN company_gstins cg ON cg.id = jl.company_gstin_id
    WHERE jl.je_id = ? ORDER BY jl.line_no`);
  for (const je of entries) je.lines = await getLines.all(je.id);
  return entries;
}

function journalFilters(q) {
  const conds = [], params = [];
  if (q.type) { conds.push('je.type = ?'); params.push(q.type); }
  if (q.from) { conds.push('je.je_date >= ?'); params.push(q.from); }
  if (q.to) { conds.push('je.je_date <= ?'); params.push(q.to); }
  return { where: conds.length ? 'WHERE ' + conds.join(' AND ') : '', params };
}

app.get('/api/journal', requireAuth, requireRole('finance', 'approver'), wrap(async (req, res) => {
  const { where, params } = journalFilters(req.query);
  res.json(await journalWithLines(where, params));
}));

// export via <a href> — accepts ?token= like the attachment endpoint
app.get('/api/journal/export', wrap(async (req, res) => {
  const token = bearerToken(req) || req.query.token;
  let payload;
  try { payload = jwt.verify(token || '', JWT_SECRET); }
  catch { return res.status(401).json({ error: 'Authentication required' }); }
  if (payload.kind !== 'staff') return res.status(403).json({ error: 'Not a staff session' });

  const { where, params } = journalFilters(req.query);
  const entries = await journalWithLines(where, params);
  const rows = [];
  for (const je of entries) {
    for (const l of je.lines) {
      rows.push({
        je_number: je.je_number, je_date: je.je_date, type: je.type, narration: je.narration || '',
        gl_period: je.gl_period || '',
        account_code: l.account_code, account_name: l.account_name,
        gl_account_code: l.gl_account_code || '',
        debit: l.debit, credit: l.credit,
        vendor: l.vendor_name || '', gstin: l.gstin_label || '', tds_section: l.tds_section || '',
        sub_location: l.sub_location || '', cost_centre: l.cost_centre || '',
        program_product_code: l.program_product_code || '', gl_description: l.gl_description || '',
        custom_field_1: l.custom_field_1 || '', custom_field_2: l.custom_field_2 || '',
        custom_field_3: l.custom_field_3 || '', custom_field_4: l.custom_field_4 || '', custom_field_5: l.custom_field_5 || '',
      });
    }
  }
  const headers = ['je_number', 'je_date', 'type', 'narration', 'gl_period', 'account_code', 'account_name', 'gl_account_code',
    'debit', 'credit', 'vendor', 'gstin', 'tds_section', 'sub_location', 'cost_centre', 'program_product_code', 'gl_description',
    'custom_field_1', 'custom_field_2', 'custom_field_3', 'custom_field_4', 'custom_field_5'];

  if (req.query.format === 'xlsx') {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Journal');
    ws.columns = headers.map((h) => ({ header: h.replace(/_/g, ' ').toUpperCase(), key: h, width: h === 'narration' || h === 'account_name' ? 34 : 16 }));
    ws.getRow(1).font = { bold: true };
    rows.forEach((r) => ws.addRow(r));
    ws.getColumn('debit').numFmt = '#,##0.00';
    ws.getColumn('credit').numFmt = '#,##0.00';
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="journal-export.xlsx"');
    await wb.xlsx.write(res);
    return res.end();
  }
  const csvEsc = (v) => `"${String(v).replace(/"/g, '""')}"`;
  const csv = [headers.join(','), ...rows.map((r) => headers.map((h) => csvEsc(r[h])).join(','))].join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="journal-export.csv"');
  res.send(csv);
}));

// ---------- vendor statement (AP ledger per vendor) ----------
app.get('/api/vendors/:id/statement', requireAuth, requireRole('finance', 'procurement'), wrap(async (req, res) => {
  const vendor = await db.prepare('SELECT * FROM vendors WHERE id = ?').get(req.params.id);
  if (!vendor) return res.status(404).json({ error: 'Vendor not found' });
  const lines = await db.prepare(`
    SELECT jl.debit, jl.credit, jl.tds_section, jl.account_name,
           je.je_number, je.je_date, je.type, je.narration
    FROM journal_lines jl
    JOIN journal_entries je ON je.id = jl.je_id
    WHERE jl.vendor_id = ? AND jl.account_code = '2100'
    ORDER BY je.je_date, je.id, jl.line_no`).all(vendor.id);
  let balance = 0;
  for (const l of lines) {
    balance = r2(balance + l.credit - l.debit); // credit balance = amount we owe
    l.balance = balance;
  }
  if (req.query.format === 'csv') {
    const csvEsc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const csv = ['date,je_number,type,narration,debit,credit,balance',
      ...lines.map((l) => [l.je_date, l.je_number, l.type, l.narration, l.debit, l.credit, l.balance].map(csvEsc).join(','))].join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="statement-${vendor.code}.csv"`);
    return res.send(csv);
  }
  res.json({ vendor: { id: vendor.id, code: vendor.code, name: vendor.name }, lines, balance });
}));

// ---------- TDS / RCM deposits ----------
app.get('/api/tax/summary', requireAuth, requireRole('finance'), wrap(async (req, res) => {
  // liability accrued in the month of booking (journal credits); deposits counted
  // against the liability period stated on the challan
  const tds = await db.prepare(`
    SELECT s.section, s.period,
      COALESCE((SELECT SUM(jl.credit) FROM journal_lines jl JOIN journal_entries je ON je.id = jl.je_id
                WHERE jl.account_code = '2200' AND jl.tds_section = s.section AND jl.credit > 0
                  AND substr(je.je_date, 1, 7) = s.period), 0) AS accrued,
      COALESCE((SELECT SUM(d.amount) FROM tds_deposits d
                WHERE d.kind = 'tds' AND d.section = s.section AND d.period = s.period), 0) AS deposited
    FROM (
      SELECT DISTINCT jl.tds_section AS section, substr(je.je_date, 1, 7) AS period
      FROM journal_lines jl JOIN journal_entries je ON je.id = jl.je_id
      WHERE jl.account_code = '2200' AND jl.credit > 0
      UNION
      SELECT section, period FROM tds_deposits WHERE kind = 'tds'
    ) s ORDER BY s.period DESC, s.section`).all();
  const rcm = await db.prepare(`
    SELECT s.period,
      COALESCE((SELECT SUM(jl.credit) FROM journal_lines jl JOIN journal_entries je ON je.id = jl.je_id
                WHERE jl.account_code = '2210' AND jl.credit > 0
                  AND substr(je.je_date, 1, 7) = s.period), 0) AS accrued,
      COALESCE((SELECT SUM(d.amount) FROM tds_deposits d WHERE d.kind = 'rcm' AND d.period = s.period), 0) AS deposited
    FROM (
      SELECT DISTINCT substr(je.je_date, 1, 7) AS period
      FROM journal_lines jl JOIN journal_entries je ON je.id = jl.je_id
      WHERE jl.account_code = '2210' AND jl.credit > 0
      UNION
      SELECT period FROM tds_deposits WHERE kind = 'rcm'
    ) s ORDER BY s.period DESC`).all();
  const deposits = await db.prepare(`
    SELECT d.*, u.full_name AS created_by_name, je.je_number
    FROM tds_deposits d LEFT JOIN users u ON u.id = d.created_by LEFT JOIN journal_entries je ON je.id = d.je_id
    ORDER BY d.id DESC`).all();
  res.json({ tds, rcm, deposits });
}));

app.post('/api/tax/deposits', requireAuth, requireRole('finance'), wrap(async (req, res) => {
  const b = req.body;
  const kind = b.kind === 'rcm' ? 'rcm' : 'tds';
  if (kind === 'tds' && !b.section) throw new Error('TDS section is required');
  if (!/^\d{4}-\d{2}$/.test(b.period || '')) throw new Error('Period must be YYYY-MM');
  const amount = r2(Number(b.amount));
  if (!(amount > 0)) throw new Error('Amount must be greater than zero');
  if (!b.deposit_date) throw new Error('Deposit date is required');
  const { id, depNumber } = await db.tx(async () => {
    const depNumber = await nextNumber('DEP', 'tds_deposits', 'deposit_number');
    const depId = (await db.prepare(`INSERT INTO tds_deposits (deposit_number, kind, period, section, amount, challan_no, bsr_code, deposit_date, notes, created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(depNumber, kind, b.period, kind === 'tds' ? b.section : null, amount,
           b.challan_no || null, b.bsr_code || null, b.deposit_date, b.notes || null, req.user.id)).lastInsertRowid;
    const dep = await db.prepare('SELECT * FROM tds_deposits WHERE id = ?').get(depId);
    const { jeId } = await postDepositJE(dep, req.user.id);
    await db.prepare('UPDATE tds_deposits SET je_id = ? WHERE id = ?').run(jeId, depId);
    return { id: depId, depNumber };
  });
  audit(req.user.id, 'create', 'tax_deposit', id, depNumber);
  res.status(201).json({ id, deposit_number: depNumber });
}));

// ---------- GSTR-2B reconciliation ----------
const csvUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
const normRef = (s) => String(s || '').replace(/\s+/g, '').toUpperCase();

app.post('/api/gst/gstr2b/import', requireAuth, requireRole('finance'), csvUpload.single('file'), wrap(async (req, res) => {
  const gstinId = Number(req.body.company_gstin_id);
  const period = req.body.period;
  if (!await db.prepare('SELECT id FROM company_gstins WHERE id = ?').get(gstinId)) throw new Error('Select a company GSTIN');
  if (!/^\d{4}-\d{2}$/.test(period || '')) throw new Error('Period must be YYYY-MM');
  if (!req.file) throw new Error('Upload the GSTR-2B CSV file');

  // expected headers: supplier_gstin,invoice_no,invoice_date,taxable_value,cgst,sgst,igst[,supplier_name]
  const text = req.file.buffer.toString('utf8').replace(/^﻿/, '');
  const rows = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
    .map((l) => l.split(',').map((c) => c.trim().replace(/^"|"$/g, '')));
  const header = rows.shift().map((h) => h.toLowerCase().replace(/\s+/g, '_'));
  const col = (name) => header.indexOf(name);
  for (const required of ['supplier_gstin', 'invoice_no', 'taxable_value']) {
    if (col(required) === -1) throw new Error(`CSV is missing the "${required}" column (expected headers: supplier_gstin,invoice_no,invoice_date,taxable_value,cgst,sgst,igst)`);
  }

  const TOL = 1; // ₹1 rounding tolerance on each value
  const result = await db.tx(async () => {
    await db.prepare('DELETE FROM gstr2b_lines WHERE company_gstin_id = ? AND period = ?').run(gstinId, period);
    // candidate book invoices: this GSTIN, non-RCM, dated in the period
    const bookInvoices = await db.prepare(`
      SELECT i.*, v.gstin AS vendor_gstin FROM invoices i JOIN vendors v ON v.id = i.vendor_id
      WHERE i.company_gstin_id = ? AND i.rcm = 0 AND i.status NOT IN ('rejected','cancelled')
        AND substr(i.invoice_date, 1, 7) = ?`).all(gstinId, period);
    const matchedIds = new Set();
    const insLine = db.prepare(`INSERT INTO gstr2b_lines
      (company_gstin_id, period, supplier_gstin, supplier_name, invoice_no, invoice_date, taxable_value, cgst, sgst, igst, matched_invoice_id, match_status)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
    let matched = 0, mismatched = 0, notInBooks = 0;

    for (const r of rows) {
      const line = {
        supplier_gstin: normRef(r[col('supplier_gstin')]),
        supplier_name: col('supplier_name') !== -1 ? r[col('supplier_name')] : null,
        invoice_no: r[col('invoice_no')],
        invoice_date: col('invoice_date') !== -1 ? r[col('invoice_date')] : null,
        taxable_value: Number(r[col('taxable_value')]) || 0,
        cgst: col('cgst') !== -1 ? Number(r[col('cgst')]) || 0 : 0,
        sgst: col('sgst') !== -1 ? Number(r[col('sgst')]) || 0 : 0,
        igst: col('igst') !== -1 ? Number(r[col('igst')]) || 0 : 0,
      };
      const inv = bookInvoices.find((i) => !matchedIds.has(i.id)
        && normRef(i.vendor_gstin) === line.supplier_gstin
        && normRef(i.vendor_invoice_ref) === normRef(line.invoice_no));
      let status = 'not_in_books', invId = null;
      if (inv) {
        matchedIds.add(inv.id);
        invId = inv.id;
        const diffs = [];
        if (Math.abs(inv.subtotal - line.taxable_value) > TOL) diffs.push(`taxable ₹${inv.subtotal} vs 2B ₹${line.taxable_value}`);
        if (Math.abs(inv.cgst_amount - line.cgst) > TOL) diffs.push(`CGST ₹${inv.cgst_amount} vs ₹${line.cgst}`);
        if (Math.abs(inv.sgst_amount - line.sgst) > TOL) diffs.push(`SGST ₹${inv.sgst_amount} vs ₹${line.sgst}`);
        if (Math.abs(inv.igst_amount - line.igst) > TOL) diffs.push(`IGST ₹${inv.igst_amount} vs ₹${line.igst}`);
        status = diffs.length ? 'mismatch' : 'matched';
        await db.prepare('UPDATE invoices SET gstr2b_status = ?, gstr2b_period = ?, gstr2b_notes = ? WHERE id = ?')
          .run(status, period, diffs.join('; ') || null, inv.id);
        if (status === 'matched') matched++; else mismatched++;
      } else {
        notInBooks++;
      }
      await insLine.run(gstinId, period, line.supplier_gstin, line.supplier_name, line.invoice_no, line.invoice_date,
        line.taxable_value, line.cgst, line.sgst, line.igst, invId, status);
    }
    // book invoices with GST in this period that GSTR-2B doesn't show
    let notIn2b = 0;
    for (const inv of bookInvoices) {
      if (!matchedIds.has(inv.id) && (inv.cgst_amount + inv.sgst_amount + inv.igst_amount) > 0) {
        await db.prepare(`UPDATE invoices SET gstr2b_status = 'not_in_2b', gstr2b_period = ?, gstr2b_notes = 'Not found in GSTR-2B for this period' WHERE id = ?`)
          .run(period, inv.id);
        notIn2b++;
      }
    }
    return { imported: rows.length, matched, mismatched, not_in_books: notInBooks, not_in_2b: notIn2b };
  });
  audit(req.user.id, 'gstr2b_import', 'company_gstin', gstinId, `${period}: ${result.imported} lines`);
  res.json(result);
}));

app.get('/api/gst/recon', requireAuth, requireRole('finance'), wrap(async (req, res) => {
  const gstinId = Number(req.query.company_gstin_id);
  const period = req.query.period;
  if (!gstinId || !/^\d{4}-\d{2}$/.test(period || '')) throw new Error('company_gstin_id and period (YYYY-MM) are required');
  const invoices = await db.prepare(`
    SELECT i.id, i.invoice_number, i.vendor_invoice_ref, i.invoice_date, i.subtotal,
      i.cgst_amount, i.sgst_amount, i.igst_amount, i.gstr2b_status, i.gstr2b_notes, v.name AS vendor_name, v.gstin AS vendor_gstin
    FROM invoices i JOIN vendors v ON v.id = i.vendor_id
    WHERE i.company_gstin_id = ? AND i.rcm = 0 AND i.status NOT IN ('rejected','cancelled')
      AND substr(i.invoice_date, 1, 7) = ?
    ORDER BY i.invoice_date`).all(gstinId, period);
  const unmatched2b = await db.prepare(`
    SELECT * FROM gstr2b_lines WHERE company_gstin_id = ? AND period = ? AND match_status = 'not_in_books'
    ORDER BY supplier_gstin, invoice_no`).all(gstinId, period);
  res.json({ invoices, unmatched2b });
}));

// ================= VENDOR PORTAL API =================

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
  res.json({ user: { email: req.vendorUser.email, full_name: req.vendorUser.full_name }, vendor, gst_states: GST_STATES });
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

// POs visible to the vendor (only ones actually sent to them)
const VENDOR_PO_STATUSES = ['sent', 'partially_received', 'received', 'closed'];
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

// uploaded file content must match its extension, not just be named right
const FILE_SIGNATURES = {
  '.pdf': [Buffer.from('%PDF')],
  '.png': [Buffer.from([0x89, 0x50, 0x4e, 0x47])],
  '.jpg': [Buffer.from([0xff, 0xd8, 0xff])],
  '.jpeg': [Buffer.from([0xff, 0xd8, 0xff])],
};
function verifyFileSignature(filePath, originalName) {
  const sigs = FILE_SIGNATURES[path.extname(originalName).toLowerCase()];
  if (!sigs) return false;
  const fd = fs.openSync(filePath, 'r');
  const head = Buffer.alloc(8);
  fs.readSync(fd, head, 0, 8, 0);
  fs.closeSync(fd);
  return sigs.some((sig) => head.subarray(0, sig.length).equals(sig));
}

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
      if (!po.company_gstin_id) throw new Error('This PO has no GST registration assigned — contact the buyer');
      const vendor = await db.prepare('SELECT * FROM vendors WHERE id = ?').get(po.vendor_id);
      const t = await prepareInvoiceTax(po, vendor, b);
      const { receivedDate, dueDate } = prepareReceiptAndDueDate(vendor, b);
      const gl = await prepareInvoiceGlFields(vendor, b);

      const match = await computeMatch(po.id, t.sub);
      // one transaction for number + insert + approval chain: concurrent
      // submissions can't collide on the invoice number, and a half-created
      // invoice (no approval chain) can never be left behind
      const { id, invNumber } = await db.tx(async () => {
        const invNumber = await nextNumber('INV', 'invoices', 'invoice_number');
        await assertNotDuplicateInvoice(po.vendor_id, b.vendor_invoice_ref);
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
        return { id, invNumber };
      });
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
  res.sendFile(path.join(__dirname, '..', 'public', 'vendor.html'));
});

// SPA fallback
app.get(/^\/(?!api\/).*/, (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// ---------- stale-approval reminders ----------
// Every few hours, re-notify the current approvers of anything pending longer
// than REMIND_AFTER_DAYS (default 3). reminded_at prevents daily spam.
const REMIND_AFTER_DAYS = Number(process.env.REMIND_AFTER_DAYS) || 3;

async function sendApprovalReminders() {
  try {
    const stale = await db.prepare(`
      SELECT da.* FROM doc_approvals da
      WHERE da.status = 'pending'
        AND da.created_at < to_char(now() - make_interval(days => ?), 'YYYY-MM-DD HH24:MI:SS')
        AND (da.reminded_at IS NULL OR da.reminded_at < to_char(now() - make_interval(days => ?), 'YYYY-MM-DD HH24:MI:SS'))
      ORDER BY da.doc_type, da.doc_id, da.seq`).all(REMIND_AFTER_DAYS, REMIND_AFTER_DAYS);
    for (const step of stale) {
      // only the CURRENT (lowest pending) step of a still-open document
      const current = await approvals.currentStep(step.doc_type, step.doc_id);
      if (!current || current.id !== step.id) continue;
      const doc = step.doc_type === 'pr'
        ? await db.prepare(`SELECT pr_number AS number, department_id, status FROM prs WHERE id = ?`).get(step.doc_id)
        : await db.prepare(`SELECT invoice_number AS number, department_id, status FROM invoices WHERE id = ?`).get(step.doc_id);
      if (!doc || !['submitted', 'pending'].includes(doc.status)) continue;
      sendMail(stepEmails(step, doc.department_id),
        `[P2P] Reminder: ${doc.number} still awaiting your approval`,
        [`${step.doc_type === 'pr' ? 'Requisition' : 'Invoice'} <strong>${doc.number}</strong> has been waiting for your approval since ${step.created_at.slice(0, 10)}.`],
        step.doc_type === 'pr' ? `#/prs/${step.doc_id}` : `#/invoices/${step.doc_id}`);
      await db.prepare(`UPDATE doc_approvals SET reminded_at = to_char(now(), 'YYYY-MM-DD HH24:MI:SS') WHERE id = ?`).run(step.id);
    }
  } catch (e) {
    console.error('Approval reminders failed:', e.message);
  }
}

async function main() {
  await init();   // create schema if needed
  await seed();   // demo data in dev / clean admin in production (first run only)
  setTimeout(sendApprovalReminders, 30 * 1000).unref();               // shortly after boot
  setInterval(sendApprovalReminders, 6 * 60 * 60 * 1000).unref();     // then every 6 hours
  app.listen(PORT, () => {
    console.log(`P2P app running at http://localhost:${PORT}`);
    console.log('Demo logins: admin/admin123, priya/priya123 (procurement), rahul/rahul123 (finance), meera/meera123 (approver), vikram/vikram123 (requester)');
  });
}

main().catch((e) => {
  console.error('Startup failed:', e.message);
  process.exit(1);
});
