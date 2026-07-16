// Combined P2P server: mounts the core plus every licensed module (MODULES
// env — see src/modules.js). The vendor portal can instead run as its own
// container via src/vendor-server.js; in that case start this server with
// MODULES that exclude vendor_portal and let the reverse proxy route
// /vendor + /api/vendor to the portal container.
const path = require('path');
const { db, init } = require('./db');
const { seed } = require('./seed');
const modules = require('./modules');
const approvals = require('./approvals');
const { createBaseApp } = require('./app-base');
const { sendMail, stepEmails } = require('./mailer');

const PORT = process.env.PORT || 9139;

const app = createBaseApp();

// ---------- core (always on) ----------
require('./routes/auth')(app);
require('./routes/admin')(app);
require('./routes/vendors')(app);
require('./routes/procurement')(app);
require('./routes/invoices')(app);
require('./routes/dashboard')(app);

// ---------- licensed modules ----------
if (modules.enabled('tax')) require('./routes/tax')(app);
if (modules.enabled('payments')) require('./routes/payments')(app);
if (modules.enabled('vendor_portal')) {
  require('./routes/vendor-portal')(app);
} else {
  // make the gap explicit instead of letting the SPA fallback swallow it
  app.all(['/vendor', '/api/vendor', '/api/vendor/*'], (req, res) =>
    res.status(404).json({ error: 'The vendor portal module is not enabled on this installation' }));
}

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
    console.log(`Modules enabled: core + ${modules.ENABLED.length ? modules.ENABLED.join(', ') : '(none)'}`);
    console.log('Demo logins: admin/admin123, priya/priya123 (procurement), rahul/rahul123 (finance), meera/meera123 (approver), vikram/vikram123 (requester)');
  });
}

main().catch((e) => {
  console.error('Startup failed:', e.message);
  process.exit(1);
});
