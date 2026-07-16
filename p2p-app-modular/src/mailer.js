// Outbound email. Configure via environment:
//   SMTP_HOST, SMTP_PORT (default 587), SMTP_SECURE=1 (for port 465),
//   SMTP_USER, SMTP_PASS, SMTP_FROM (e.g. "P2P Manager <p2p@company.com>"),
//   APP_URL (public URL used in links, e.g. https://p2p.company.com)
//
// Without SMTP_HOST the app still works: every notification is recorded in the
// mail_outbox table with status 'logged' (visible to admins) instead of sent.
// Sending is fire-and-forget — a mail failure never breaks the business action.
const nodemailer = require('nodemailer');
const { db } = require('./db');

const APP_URL = (process.env.APP_URL || 'http://localhost:9139').replace(/\/$/, '');
const FROM = process.env.SMTP_FROM || 'P2P Manager <no-reply@localhost>';

let transport = null;
if (process.env.SMTP_HOST) {
  transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: process.env.SMTP_SECURE === '1',
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
  });
  console.log(`Mailer: SMTP via ${process.env.SMTP_HOST}`);
} else {
  console.log('Mailer: SMTP not configured — notifications recorded in outbox only (set SMTP_HOST to send)');
}

// `to` may be a value, an array, a promise, or an array containing promises —
// everything is resolved here so call sites stay fire-and-forget.
async function sendMail(to, subject, lines, linkPath) {
  try {
    const recipients = (await Promise.all([].concat(await to))).filter(Boolean);
    const unique = [...new Set(recipients.map((r) => String(r).trim().toLowerCase()))].filter((r) => r.includes('@'));
    if (!unique.length) return;
    const link = linkPath ? `${APP_URL}${linkPath}` : APP_URL;
    const text = `${lines.join('\n')}\n\nOpen: ${link}\n\n— P2P Manager (automated notification)`;
    const html = `<div style="font-family:sans-serif;font-size:14px;line-height:1.7">
      ${lines.map((l) => `<p style="margin:4px 0">${l}</p>`).join('')}
      <p style="margin:14px 0"><a href="${link}" style="background:#2563eb;color:#fff;padding:9px 18px;border-radius:8px;text-decoration:none">Open P2P Manager</a></p>
      <p style="color:#64748b;font-size:12px">— P2P Manager (automated notification)</p></div>`;

    for (const rcpt of unique) {
      const rowId = (await db.prepare('INSERT INTO mail_outbox (to_email, subject, body, status) VALUES (?,?,?,?)')
        .run(rcpt, subject, text, transport ? 'queued' : 'logged')).lastInsertRowid;
      if (!transport) continue;
      transport.sendMail({ from: FROM, to: rcpt, subject, text, html })
        .then(() => db.prepare(`UPDATE mail_outbox SET status='sent', sent_at=to_char(now(), 'YYYY-MM-DD HH24:MI:SS') WHERE id=?`).run(rowId))
        .catch(async (err) => {
          console.error(`Mail to ${rcpt} failed:`, err.message);
          await db.prepare(`UPDATE mail_outbox SET status='failed', error=? WHERE id=?`).run(err.message, rowId);
        });
    }
  } catch (e) {
    console.error('sendMail failed:', e.message);
  }
}

// ---- recipient helpers (all async — sendMail resolves them) ----
const usersByRole = async (...roles) => (await db.prepare(
  `SELECT email FROM users WHERE active = 1 AND email IS NOT NULL AND role IN (${roles.map(() => '?').join(',')})`
).all(...roles)).map((u) => u.email);

const userEmail = async (id) => {
  const u = await db.prepare('SELECT email FROM users WHERE id = ? AND active = 1').get(id);
  return u ? u.email : null;
};

// emails for whoever can act on an approval step
async function stepEmails(step, departmentId) {
  if (!step) return [];
  if (step.approver_kind === 'department_head') {
    if (!departmentId) return [];
    const d = await db.prepare('SELECT head_user_id, deputy_user_id FROM departments WHERE id = ?').get(departmentId);
    if (!d) return [];
    const out = [];
    if (d.head_user_id) out.push(await userEmail(d.head_user_id));
    if (d.deputy_user_id) out.push(await userEmail(d.deputy_user_id));
    return out;
  }
  if (step.approver_kind === 'role') return usersByRole(step.approver_ref);
  return [await userEmail(Number(step.approver_ref))];
}

const vendorEmails = async (vendorId) => {
  const v = await db.prepare('SELECT email FROM vendors WHERE id = ?').get(vendorId);
  const portal = (await db.prepare('SELECT email FROM vendor_users WHERE vendor_id = ? AND active = 1').all(vendorId)).map((x) => x.email);
  return [v && v.email, ...portal];
};

module.exports = { sendMail, usersByRole, userEmail, stepEmails, vendorEmails };
