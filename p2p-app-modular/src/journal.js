// Auto-posted double-entry journals for the P2P lifecycle.
// Accounts are a fixed built-in chart; lines carry vendor / GSTIN / TDS-section
// dimensions so vendor statements and tax registers fall out of the same data.
//
// Every line also carries external-GL metadata (gl_account_code, sub_location,
// cost_centre, program_product_code, gl_description, custom_field_1-5) so the
// same data can feed Tally/SUN6/Dynamics-style journal imports later. These
// are frozen text snapshots taken at posting time — same convention as
// tds_section below — so a later rename of a master code never rewrites what
// was already posted.
const { db, nextNumber } = require('./db');

const ACCOUNTS = {
  BANK: ['1000', 'Bank'],
  GST_INPUT_CGST: ['1410', 'GST Input — CGST'],
  GST_INPUT_SGST: ['1411', 'GST Input — SGST'],
  GST_INPUT_IGST: ['1412', 'GST Input — IGST'],
  GST_INPUT_IGST_RCM: ['1413', 'GST Input — IGST (RCM)'],
  AP: ['2100', 'Accounts Payable'],
  TDS_PAYABLE: ['2200', 'TDS Payable'],
  RCM_PAYABLE: ['2210', 'RCM GST Payable'],
  EXPENSE: ['5000', 'Purchases / Expenses'],
};

const r2 = (n) => Math.round(n * 100) / 100;

// Which external GL code applies to a given internal account, given the
// resolved vendor/GSTIN/TDS-section context. EXPENSE and BANK have no natural
// per-vendor/per-GSTIN source, so they stay unmapped (null) unless the caller
// supplies one explicitly.
function glCodeFor(accountKey, ctx) {
  switch (accountKey) {
    case 'AP': return ctx.vendorApCode || null;
    case 'TDS_PAYABLE': return ctx.tdsAccountCode || null;
    case 'GST_INPUT_CGST': return (ctx.gstin && ctx.gstin.gst_input_cgst_code) || null;
    case 'GST_INPUT_SGST': return (ctx.gstin && ctx.gstin.gst_input_sgst_code) || null;
    case 'GST_INPUT_IGST': return (ctx.gstin && ctx.gstin.gst_input_igst_code) || null;
    case 'GST_INPUT_IGST_RCM': return (ctx.gstin && ctx.gstin.gst_rcm_input_code) || null;
    case 'RCM_PAYABLE': return (ctx.gstin && ctx.gstin.gst_rcm_payable_code) || null;
    default: return null;
  }
}

/**
 * Insert a balanced journal entry. lines: array of
 * { account: ACCOUNTS key, debit?, credit?, vendor_id?, company_gstin_id?, tds_section?, glAccountCode? }
 * glMeta (optional): { subLocation, costCentre, programProductCode, glDescription,
 *   customField1..5 } — applied identically to every line.
 * glPeriod (optional): posting period (YYYY-MM), stored once on the journal entry.
 */
async function postJE({ type, refType, refId, jeDate, narration, userId, lines, glMeta, glPeriod }) {
  const clean = lines
    .map((l) => ({ ...l, debit: r2(l.debit || 0), credit: r2(l.credit || 0) }))
    .filter((l) => l.debit > 0 || l.credit > 0);
  const dr = r2(clean.reduce((s, l) => s + l.debit, 0));
  const cr = r2(clean.reduce((s, l) => s + l.credit, 0));
  if (Math.abs(dr - cr) > 0.01) {
    throw new Error(`Journal does not balance (Dr ${dr} vs Cr ${cr}) — refusing to post`);
  }
  const meta = glMeta || {};
  return db.tx(async () => {
    const jeNumber = await nextNumber('JE', 'journal_entries', 'je_number');
    const jeId = (await db.prepare(`INSERT INTO journal_entries (je_number, je_date, type, ref_type, ref_id, narration, gl_period, created_by)
      VALUES (?,?,?,?,?,?,?,?)`).run(jeNumber, jeDate, type, refType || null, refId || null, narration || null, glPeriod || null, userId || null)).lastInsertRowid;
    const ins = db.prepare(`INSERT INTO journal_lines
      (je_id, line_no, account_code, account_name, debit, credit, vendor_id, company_gstin_id, tds_section,
       gl_account_code, sub_location, cost_centre, program_product_code, gl_description,
       custom_field_1, custom_field_2, custom_field_3, custom_field_4, custom_field_5)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    for (let i = 0; i < clean.length; i++) {
      const l = clean[i];
      const [code, name] = ACCOUNTS[l.account];
      await ins.run(jeId, i + 1, code, l.tds_section ? `${name} u/s ${l.tds_section}` : name,
        l.debit, l.credit, l.vendor_id || null, l.company_gstin_id || null, l.tds_section || null,
        l.glAccountCode || null, meta.subLocation || null, meta.costCentre || null,
        meta.programProductCode || null, meta.glDescription || null,
        meta.customField1 || null, meta.customField2 || null, meta.customField3 || null,
        meta.customField4 || null, meta.customField5 || null);
    }
    return { jeId, jeNumber };
  });
}

// Resolve everything needed to map internal accounts -> external GL codes for
// one invoice: the vendor's AP code, its GSTIN's GST/RCM codes, and the
// account code configured against the chosen TDS section.
async function resolveGlContext(inv) {
  const vendor = await db.prepare('SELECT ap_account_code FROM vendors WHERE id = ?').get(inv.vendor_id);
  const gstin = inv.company_gstin_id
    ? await db.prepare('SELECT * FROM company_gstins WHERE id = ?').get(inv.company_gstin_id)
    : null;
  // a section string can have several rate-variant rows (e.g. 194J at 2% and
  // 10%) — prefer whichever row actually has an account code configured, so a
  // later edit to one variant isn't shadowed by an older, unconfigured one
  const tdsRow = inv.tds_section
    ? await db.prepare(`SELECT account_code FROM tds_sections WHERE section = ? AND active = 1
        ORDER BY account_code IS NULL, id LIMIT 1`).get(inv.tds_section)
    : null;
  return { vendorApCode: vendor && vendor.ap_account_code, gstin, tdsAccountCode: tdsRow && tdsRow.account_code };
}

// Dimensional tags captured on the invoice (submission + final approval),
// carried onto every line of its JE for a flat, self-describing GL export.
function glMetaFor(inv) {
  return {
    subLocation: inv.sub_location, costCentre: inv.cost_centre,
    programProductCode: inv.program_product_code, glDescription: inv.gl_description,
    customField1: inv.custom_field_1, customField2: inv.custom_field_2,
    customField3: inv.custom_field_3, customField4: inv.custom_field_4, customField5: inv.custom_field_5,
  };
}

/**
 * Invoice booking on approval. AP is credited GROSS; TDS appears as a separate
 * AP debit line so vendor statements show the deduction explicitly.
 * RCM: vendor is only owed the taxable value; IGST is self-assessed
 * (Dr input / Cr RCM payable). Ineligible ITC is expensed instead.
 */
async function postInvoiceBookingJE(inv, userId) {
  const gstinDim = { company_gstin_id: inv.company_gstin_id };
  const vendorDim = { vendor_id: inv.vendor_id, ...gstinDim };
  const itcOk = inv.itc_eligibility === 'eligible';
  const gst = r2(inv.cgst_amount + inv.sgst_amount + inv.igst_amount);
  const lines = [];

  if (inv.rcm) {
    lines.push({ account: 'EXPENSE', debit: inv.subtotal + (itcOk ? 0 : gst), ...gstinDim });
    if (itcOk && inv.igst_amount > 0) lines.push({ account: 'GST_INPUT_IGST_RCM', debit: inv.igst_amount, ...gstinDim });
    if (inv.igst_amount > 0) lines.push({ account: 'RCM_PAYABLE', credit: inv.igst_amount, ...gstinDim });
    lines.push({ account: 'AP', credit: inv.total, ...vendorDim });
  } else {
    lines.push({ account: 'EXPENSE', debit: inv.subtotal + (itcOk ? 0 : gst), ...gstinDim });
    if (itcOk) {
      if (inv.cgst_amount > 0) lines.push({ account: 'GST_INPUT_CGST', debit: inv.cgst_amount, ...gstinDim });
      if (inv.sgst_amount > 0) lines.push({ account: 'GST_INPUT_SGST', debit: inv.sgst_amount, ...gstinDim });
      if (inv.igst_amount > 0) lines.push({ account: 'GST_INPUT_IGST', debit: inv.igst_amount, ...gstinDim });
    }
    lines.push({ account: 'AP', credit: inv.total, ...vendorDim });
  }
  if (inv.tds_amount > 0) {
    lines.push({ account: 'AP', debit: inv.tds_amount, ...vendorDim, tds_section: inv.tds_section });
    lines.push({ account: 'TDS_PAYABLE', credit: inv.tds_amount, tds_section: inv.tds_section, ...gstinDim });
  }

  const ctx = await resolveGlContext(inv);
  lines.forEach((l) => { l.glAccountCode = glCodeFor(l.account, ctx); });

  return postJE({
    type: 'invoice_booking', refType: 'invoice', refId: inv.id, jeDate: inv.invoice_date,
    narration: `Booking ${inv.invoice_number}${inv.vendor_invoice_ref ? ` (vendor ref ${inv.vendor_invoice_ref})` : ''}${inv.rcm ? ' [RCM]' : ''}`,
    userId, lines, glMeta: glMetaFor(inv), glPeriod: inv.gl_period,
  });
}

async function postPaymentJE(payment, inv, userId) {
  const vendor = await db.prepare('SELECT ap_account_code FROM vendors WHERE id = ?').get(inv.vendor_id);
  const apCode = vendor && vendor.ap_account_code;
  return postJE({
    type: 'payment', refType: 'payment', refId: payment.id, jeDate: payment.payment_date,
    narration: `Payment ${payment.payment_number} against ${inv.invoice_number}`,
    userId,
    lines: [
      { account: 'AP', debit: payment.amount, vendor_id: inv.vendor_id, company_gstin_id: inv.company_gstin_id, glAccountCode: apCode || null },
      { account: 'BANK', credit: payment.amount },
    ],
    glMeta: glMetaFor(inv),
  });
}

async function postDepositJE(dep, userId) {
  const liability = dep.kind === 'rcm' ? 'RCM_PAYABLE' : 'TDS_PAYABLE';
  // RCM deposits have no vendor/GSTIN reference to resolve a code from; TDS
  // deposits can resolve one via the section's own master record.
  const tdsRow = dep.kind === 'tds' && dep.section
    ? await db.prepare(`SELECT account_code FROM tds_sections WHERE section = ? AND active = 1
        ORDER BY account_code IS NULL, id LIMIT 1`).get(dep.section)
    : null;
  return postJE({
    type: dep.kind === 'rcm' ? 'rcm_deposit' : 'tds_deposit',
    refType: 'tds_deposit', refId: dep.id, jeDate: dep.deposit_date,
    narration: `${dep.kind === 'rcm' ? 'RCM GST' : `TDS u/s ${dep.section}`} deposit for ${dep.period}${dep.challan_no ? `, challan ${dep.challan_no}` : ''}`,
    userId,
    lines: [
      { account: liability, debit: dep.amount, tds_section: dep.kind === 'tds' ? dep.section : null,
        glAccountCode: tdsRow && tdsRow.account_code },
      { account: 'BANK', credit: dep.amount },
    ],
  });
}

module.exports = { ACCOUNTS, postJE, postInvoiceBookingJE, postPaymentJE, postDepositJE, r2 };
