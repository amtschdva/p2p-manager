// Core: staff authentication, TOTP two-factor, password change.
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { authenticator } = require('otplib');
const QRCode = require('qrcode');
const { db, audit } = require('../db');
const modules = require('../modules');
const { JWT_SECRET, TOKEN_TTL, loginLimiter, requireAuth, wrap, checkPassword } = require('../context');

authenticator.options = { window: 1 }; // tolerate ±30s clock drift

// login/me responses carry the enabled module list so the SPA can gate its nav
const userPayload = (user) => ({
  id: user.id, username: user.username, full_name: user.full_name,
  role: user.role, department_id: user.department_id,
});

module.exports = function register(app) {
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
    res.json({ token, user: userPayload(user), modules: modules.ENABLED });
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
    res.json({ token, user: userPayload(user), modules: modules.ENABLED });
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

  app.get('/api/auth/me', requireAuth, (req, res) => res.json({ ...req.user, modules: modules.ENABLED }));

  app.post('/api/auth/change-password', requireAuth, wrap(async (req, res) => {
    const { current_password, new_password } = req.body || {};
    checkPassword(new_password);
    const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    if (!bcrypt.compareSync(current_password || '', user.password_hash)) throw new Error('Current password is incorrect');
    await db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(new_password, 10), req.user.id);
    audit(req.user.id, 'change_password', 'user', req.user.id, null);
    res.json({ ok: true });
  }));
};
