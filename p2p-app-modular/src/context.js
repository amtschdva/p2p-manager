// Shared plumbing used by every route module: JWT auth, role checks, rate
// limiters, upload handling and small helpers. Route modules require this
// directly so they stay self-contained.
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const { db, DATA_DIR } = require('./db');

const PROD = process.env.NODE_ENV === 'production';
if (PROD && !process.env.JWT_SECRET) {
  console.error('FATAL: JWT_SECRET must be set in production (e.g. openssl rand -hex 32)');
  process.exit(1);
}
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
const TOKEN_TTL = '8h';

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

const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
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

// payment releases are reserved for the head of the department named "Finance"
// (falls back to any other finance user when no such head is configured)
const financeHead = () => db.prepare(
  `SELECT head_user_id FROM departments WHERE lower(name) = 'finance' AND active = 1 AND head_user_id IS NOT NULL`).get();

module.exports = {
  PROD, JWT_SECRET, TOKEN_TTL,
  loginLimiter, registerLimiter,
  fmtInr, checkPassword,
  UPLOAD_DIR, upload, verifyFileSignature,
  bearerToken, requireAuth, requireVendorAuth, requireRole, wrap,
  financeHead,
};
