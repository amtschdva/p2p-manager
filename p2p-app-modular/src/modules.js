// License-gated feature modules.
//
// The core app (auth, users, departments, approval matrix, vendors + KYC,
// PR → PO → GRN, invoices + 3-way match, dashboard, notifications) is always
// on. Everything else is a module enabled via the MODULES env var:
//
//   MODULES unset / "all"      → every shipped module (the default)
//   MODULES=tax,payments       → only those (comma-separated)
//   MODULES=core / MODULES=""  → core only
//
// Disabled module = its routes are never mounted and its nav items are hidden
// (the frontend reads the enabled list from the login / /auth/me responses).
// The database schema always contains every module's tables, so enabling a
// module later is a config change, not a migration.

// Modules that ship today. 'inventory' has its schema prepared (items,
// warehouses, stock_ledger — see db.js) but no routes yet, so it is not
// enableable until the module lands.
const SHIPPED = ['tax', 'payments', 'vendor_portal'];

function parseModules(raw) {
  if (raw === undefined || raw === null || raw.trim() === 'all') return [...SHIPPED];
  const wanted = raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
    .filter((m) => m !== 'core' && m !== 'none');
  const unknown = wanted.filter((m) => !SHIPPED.includes(m));
  if (unknown.length) {
    console.warn(`MODULES: ignoring unknown module(s): ${unknown.join(', ')} (available: ${SHIPPED.join(', ')})`);
  }
  return SHIPPED.filter((m) => wanted.includes(m));
}

const ENABLED = parseModules(process.env.MODULES);

const enabled = (name) => ENABLED.includes(name);

module.exports = { SHIPPED, ENABLED, enabled };
