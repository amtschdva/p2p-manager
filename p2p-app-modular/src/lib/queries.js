// Shared list SQL and cross-module business helpers (3-way match, GST/RCM
// validation, PO receipt status). Used by the procurement, invoice, payment
// and vendor-portal route modules.
const { db } = require('../db');
const { r2 } = require('../journal');
const modules = require('../modules');
const { GST_STATES, nameForCode } = require('./gst-states');

const PR_LIST_SQL = `
  SELECT p.*, u.full_name AS requester_name, a.full_name AS approver_name, d.name AS department_name,
    (SELECT COALESCE(SUM(quantity * est_unit_price), 0) FROM pr_items WHERE pr_id = p.id) AS estimated_total
  FROM prs p
  JOIN users u ON u.id = p.requester_id
  LEFT JOIN users a ON a.id = p.approver_id
  LEFT JOIN departments d ON d.id = p.department_id`;

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

const INV_LIST_SQL = `
  SELECT i.*, v.name AS vendor_name, v.gstin AS vendor_gstin, v.vendor_type, po.po_number,
    cg.label AS gstin_label, cg.gstin AS company_gstin,
    dd.name AS department_name,
    dd.default_cost_centre AS department_default_cost_centre, dd.default_sub_location AS department_default_sub_location,
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

const PAY_LIST_SQL = `
  SELECT p.*, i.invoice_number, i.total AS invoice_total, i.tds_amount, i.department_id, v.name AS vendor_name,
    v.bank_name, v.bank_account, v.ifsc,
    u.full_name AS created_by_name, ru.full_name AS released_by_name
  FROM payments p
  JOIN invoices i ON i.id = p.invoice_id
  JOIN vendors v ON v.id = i.vendor_id
  JOIN users u ON u.id = p.created_by
  LEFT JOIN users ru ON ru.id = p.released_by`;

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

// shared GST/RCM validation for staff- and vendor-entered invoices.
// Without the tax module, GST amounts are still recorded as entered (plain
// arithmetic) but RCM/GSTR-2B behavior is off — no RCM category is required
// and nothing is queued for 2B reconciliation.
async function prepareInvoiceTax(po, vendor, body) {
  const sub = r2(Number(body.subtotal));
  if (!(sub > 0)) throw new Error('Subtotal must be greater than zero');
  const taxModule = modules.enabled('tax');
  const isOverseas = vendor.vendor_type === 'overseas';
  const rcm = taxModule && (isOverseas || body.rcm === 1 || body.rcm === '1' || body.rcm === true) ? 1 : 0;
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
    gstr2bStatus: !taxModule || rcm || isOverseas ? 'na' : 'pending' };
}

// Invoice Receipt Date + Due Date — always on (core), independent of the tax
// module: even a client with no GST/JE tracking still needs to know when a
// vendor invoice is due. Due date auto-calculates from the vendor's payment
// terms unless the caller explicitly supplies one (still editable client-side).
function prepareReceiptAndDueDate(vendor, body) {
  const receivedDate = body.received_date || body.invoice_date || null;
  let dueDate = body.due_date || null;
  if (!dueDate && receivedDate) {
    const days = Number(vendor.payment_terms_days) || 30;
    const d = new Date(receivedDate + 'T00:00:00Z');
    if (!Number.isNaN(d.getTime())) {
      d.setUTCDate(d.getUTCDate() + days);
      dueDate = d.toISOString().slice(0, 10);
    }
  }
  return { receivedDate, dueDate };
}

// Place of Supply + HSN/SAC + GL description — part of the tax module (GST
// compliance / GL-export fields). Place of Supply auto-derives from the
// vendor's GSTIN state code but can be overridden; both it and HSN/SAC are
// mandatory once the vendor carries a GSTIN (i.e. is GST-registered).
async function prepareInvoiceGlFields(vendor, body) {
  if (!modules.enabled('tax')) {
    return { placeOfSupplyCode: null, placeOfSupplyState: null, hsnSacCode: null, glDescription: null };
  }
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

module.exports = {
  PR_LIST_SQL, PO_LIST_SQL, INV_LIST_SQL, PAY_LIST_SQL,
  refreshPoReceiptStatus, computeMatch, prepareInvoiceTax,
  prepareReceiptAndDueDate, prepareInvoiceGlFields, GST_STATES,
  visibleDeptIds, canSeeDoc, assertNotDuplicateInvoice,
};
