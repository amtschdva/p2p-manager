// Module "tax": India tax & accounting — GSTIN/TDS/RCM masters, journal
// entries + export, vendor AP statements, TDS/RCM deposit tracking and
// GSTR-2B reconciliation.
const jwt = require('jsonwebtoken');
const multer = require('multer');
const ExcelJS = require('exceljs');
const { db, audit, nextNumber } = require('../db');
const { postDepositJE, r2 } = require('../journal');
const { JWT_SECRET, requireAuth, requireRole, wrap, bearerToken } = require('../context');

module.exports = function register(app) {
  // ---------- tax masters ----------
  app.get('/api/settings/gstins', requireAuth, async (req, res) => {
    res.json(await db.prepare('SELECT * FROM company_gstins ORDER BY id').all());
  });

  // 8 GL account codes (3 GST payable + 3 GST input + RCM payable + RCM input)
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
          je_number: je.je_number, je_date: je.je_date, type: je.type, gl_period: je.gl_period || '', narration: je.narration || '',
          account_code: l.account_code, account_name: l.account_name, gl_account_code: l.gl_account_code || '',
          debit: l.debit, credit: l.credit,
          vendor: l.vendor_name || '', gstin: l.gstin_label || '', tds_section: l.tds_section || '',
          sub_location: l.sub_location || '', cost_centre: l.cost_centre || '',
          program_product_code: l.program_product_code || '', gl_description: l.gl_description || '',
          custom_field_1: l.custom_field_1 || '', custom_field_2: l.custom_field_2 || '',
          custom_field_3: l.custom_field_3 || '', custom_field_4: l.custom_field_4 || '', custom_field_5: l.custom_field_5 || '',
        });
      }
    }
    // generic, ERP-agnostic layout — Tally/SUN6/Dynamics/etc. each re-map these
    // columns in their own import step rather than needing one hardcoded format
    const headers = ['je_number', 'je_date', 'gl_period', 'type', 'narration', 'account_code', 'account_name', 'gl_account_code',
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
};
