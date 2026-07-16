// Vendor KYC document storage — shared by the staff vendors module and the
// vendor portal module (self-service uploads).
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { db, DATA_DIR } = require('../db');

const VENDOR_DOCS_DIR = path.join(DATA_DIR, 'vendor-docs');
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

module.exports = { VENDOR_DOCS_DIR, VENDOR_DOC_TYPES, requiredVendorDocs, vendorDocUpload, saveVendorDocument, vendorDocsFor };
