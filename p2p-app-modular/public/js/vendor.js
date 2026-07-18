/* P2P Manager — vendor portal */
'use strict';

let VTOKEN = localStorage.getItem('p2p_vendor_token');
let ME = null; // { user, vendor, modules, gst_states }
let activeTab = 'pos';
const has = (mod) => !!(ME && ME.modules && ME.modules.includes(mod));

const $ = (sel, el = document) => el.querySelector(sel);
const fmtMoney = (n) => '₹' + Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtDate = (d) => d ? new Date(d.replace(' ', 'T')).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const STATUS_BADGE = {
  sent: 'blue', partially_received: 'amber', received: 'green', closed: 'gray',
  pending: 'amber', approved: 'green', rejected: 'red', partially_paid: 'amber', paid: 'green', cancelled: 'gray',
  matched: 'green', mismatch: 'red', unmatched: 'gray',
};
const badge = (s) => `<span class="badge badge-${STATUS_BADGE[s] || 'gray'}">${esc(String(s).replace(/_/g, ' '))}</span>`;

async function api(path, options = {}) {
  const isForm = options.body instanceof FormData;
  const res = await fetch('/api' + path, {
    ...options,
    headers: {
      ...(isForm ? {} : { 'Content-Type': 'application/json' }),
      ...(VTOKEN ? { Authorization: 'Bearer ' + VTOKEN } : {}),
      ...(options.headers || {}),
    },
    body: isForm ? options.body : options.body ? JSON.stringify(options.body) : undefined,
  });
  if (res.status === 401 && VTOKEN) { logout(); throw new Error('Session expired, please sign in again'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

function toast(msg, type = 'info') {
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.textContent = msg;
  $('#toast-container').appendChild(el);
  setTimeout(() => el.remove(), 4500);
}

function openModal(title, bodyHtml) {
  $('#modal-title').textContent = title;
  $('#modal-body').innerHTML = bodyHtml;
  $('#modal-backdrop').classList.remove('hidden');
}
function closeModal() {
  $('#modal-backdrop').classList.add('hidden');
  $('#modal-body').innerHTML = '';
}
window.closeModal = closeModal;
$('#modal-backdrop').addEventListener('click', (e) => { if (e.target.id === 'modal-backdrop') closeModal(); });

function logout() {
  VTOKEN = null; ME = null;
  localStorage.removeItem('p2p_vendor_token');
  showAuth();
}
$('#vbtn-logout').addEventListener('click', logout);
$('#vbtn-theme')?.addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  localStorage.setItem('p2p_theme', next);
});

// ---------- auth screen ----------
function showAuth() {
  $('#portal-shell').classList.add('hidden');
  $('#auth-screen').classList.remove('hidden');
}

function switchAuthTab(login) {
  $('#tab-login').classList.toggle('active', login);
  $('#tab-register').classList.toggle('active', !login);
  $('#vlogin-form').classList.toggle('hidden', !login);
  $('#vregister-form').classList.toggle('hidden', login);
}
$('#tab-login').addEventListener('click', () => switchAuthTab(true));
$('#tab-register').addEventListener('click', () => switchAuthTab(false));

$('#vlogin-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errEl = $('#vlogin-error');
  errEl.classList.add('hidden');
  try {
    const data = await api('/vendor/login', {
      method: 'POST',
      body: { email: $('#vlogin-email').value, password: $('#vlogin-password').value },
    });
    VTOKEN = data.token;
    localStorage.setItem('p2p_vendor_token', VTOKEN);
    await enterPortal();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.remove('hidden');
  }
});

$('#vregister-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errEl = $('#vregister-error');
  errEl.classList.add('hidden');
  try {
    const body = Object.fromEntries(new FormData(e.target).entries());
    const data = await api('/vendor/register', { method: 'POST', body });
    VTOKEN = data.token;
    localStorage.setItem('p2p_vendor_token', VTOKEN);
    toast(data.message, 'success');
    await enterPortal();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.remove('hidden');
  }
});

// ---------- portal ----------
async function enterPortal() {
  ME = await api('/vendor/me');
  $('#auth-screen').classList.add('hidden');
  $('#portal-shell').classList.remove('hidden');
  $('#vendor-name').textContent = ME.vendor.name;
  $('#vendor-verify-badge').innerHTML = verificationBadge();
  renderTab();
}

function verificationBadge() {
  if (ME.vendor.verified) return '<span class="badge badge-green">verified</span>';
  if (ME.vendor.status === 'blocked') return '<span class="badge badge-red">registration rejected</span>';
  return '<span class="badge badge-amber">pending verification</span>';
}

function verifyBannerHtml() {
  if (ME.vendor.verified) return '';
  if (ME.vendor.status === 'blocked') {
    return `<div class="form-error">Your registration was not approved. Please contact the procurement team for details.</div>`;
  }
  return `<div class="verify-banner">⏳ Your registration is pending verification.
    Please upload your <strong>PAN and cancelled cheque</strong> (plus GSTIN certificate if GST-registered, and
    MSME certificate if applicable) under <strong>Company Profile → Verification documents</strong> —
    finance verifies your account against them. Purchase orders and invoice submission unlock after verification.</div>`;
}

document.querySelectorAll('.portal-tabs button').forEach((b) =>
  b.addEventListener('click', () => {
    activeTab = b.dataset.tab;
    document.querySelectorAll('.portal-tabs button').forEach((x) => x.classList.toggle('active', x === b));
    renderTab();
  })
);

async function renderTab() {
  const main = $('#portal-main');
  main.innerHTML = '<div class="empty-state">Loading…</div>';
  try {
    if (activeTab === 'pos') await renderPos(main);
    else if (activeTab === 'invoices') await renderInvoices(main);
    else await renderProfile(main);
  } catch (err) {
    main.innerHTML = `<div class="card card-pad"><div class="form-error">${esc(err.message)}</div></div>`;
  }
}

// ---------- POs ----------
async function renderPos(main) {
  const pos = await api('/vendor/pos');
  main.innerHTML = `
    ${verifyBannerHtml()}
    <div class="page-header"><div><h2>Purchase Orders</h2>
      <div class="sub">Orders placed with ${esc(ME.vendor.name)}</div></div></div>
    <div class="card table-wrap"><table>
      <thead><tr><th>PO #</th><th>Issued</th><th>Expected</th><th class="num">Value</th><th>Status</th><th></th></tr></thead>
      <tbody>${pos.length ? pos.map((p, idx) => `
        <tr>
          <td><strong>${esc(p.po_number)}</strong></td>
          <td>${fmtDate(p.created_at)}</td>
          <td>${fmtDate(p.expected_date)}</td>
          <td class="num">${fmtMoney(p.total)}</td>
          <td>${badge(p.status)}</td>
          <td style="display:flex;gap:6px">
            <button class="btn btn-sm" data-view="${idx}">Details</button>
            ${ME.vendor.verified && p.status !== 'closed' ? `<button class="btn btn-sm btn-primary" data-invoice="${idx}">Submit invoice</button>` : ''}
          </td>
        </tr>`).join('') : '<tr><td colspan="6" class="empty-state">No purchase orders yet</td></tr>'}
      </tbody>
    </table></div>`;
  main.querySelectorAll('[data-view]').forEach((b) =>
    b.addEventListener('click', () => showPoDetail(pos[Number(b.dataset.view)])));
  main.querySelectorAll('[data-invoice]').forEach((b) =>
    b.addEventListener('click', () => openInvoiceForm(pos[Number(b.dataset.invoice)])));
}

function showPoDetail(po) {
  openModal(`${po.po_number} ${po.status.replace(/_/g, ' ')}`, `
    <div class="detail-grid">
      <div class="detail-item"><div class="dl">Issued</div><div class="dv">${fmtDate(po.created_at)}</div></div>
      <div class="detail-item"><div class="dl">Expected delivery</div><div class="dv">${fmtDate(po.expected_date)}</div></div>
      <div class="detail-item"><div class="dl">Order value</div><div class="dv">${fmtMoney(po.total)}</div></div>
    </div>
    ${po.notes ? `<div class="detail-item"><div class="dl">Notes</div><div class="dv" style="font-weight:400">${esc(po.notes)}</div></div>` : ''}
    <div class="section-title">Line items</div>
    <div class="table-wrap"><table>
      <thead><tr><th>Description</th><th class="num">Qty</th><th class="num">Received (accepted)</th><th class="num">Unit price</th><th class="num">Amount</th></tr></thead>
      <tbody>${po.items.map((i) => `
        <tr><td class="wrap">${esc(i.description)}</td><td class="num">${i.quantity} ${esc(i.unit)}</td>
        <td class="num">${i.received_qty}</td><td class="num">${fmtMoney(i.unit_price)}</td>
        <td class="num">${fmtMoney(i.quantity * i.unit_price)}</td></tr>`).join('')}
      </tbody>
    </table></div>`);
}

// ---------- invoice submission ----------
function openInvoiceForm(po) {
  const receivedValue = po.items.reduce((s, i) => s + i.received_qty * i.unit_price, 0);
  const overseas = ME.vendor.vendor_type === 'overseas';
  const myState = (ME.vendor.gstin || '').slice(0, 2);
  const intra = myState && po.company_state_code && myState === po.company_state_code;
  const gstFields = overseas ? `
      <div class="field full" style="background:#ede9fe;border-radius:8px;padding:10px 12px;font-size:12.5px;color:#5b21b6">
        🌏 As an overseas supplier, do not add GST — the buyer self-assesses IGST under reverse charge.</div>`
    : intra ? `
      <div class="field"><label>CGST (₹)</label><input name="cgst_amount" type="number" min="0" step="any" value="0"></div>
      <div class="field"><label>SGST (₹)</label><input name="sgst_amount" type="number" min="0" step="any" value="0"></div>`
    : `
      <div class="field"><label>IGST (₹)</label><input name="igst_amount" type="number" min="0" step="any" value="0"></div>`;
  const posCode = (ME.vendor.gstin || '').slice(0, 2);
  openModal(`Submit invoice — ${po.po_number}`, `
    <form id="vinv-form">
      <div class="form-grid">
        <div class="field"><label>Your invoice number *</label><input name="vendor_invoice_ref" required placeholder="e.g. TS/2026/1234"></div>
        <div class="field"><label>Invoice date *</label><input name="invoice_date" id="vinv-invoice-date" type="date" required value="${new Date().toISOString().slice(0, 10)}"></div>
        <div class="field"><label>Invoice Receipt Date <span style="color:var(--text-muted);font-weight:400">(when the buyer received it)</span></label>
          <input name="received_date" id="vinv-received-date" type="date"></div>
        <div class="field"><label>Due date <span style="color:var(--text-muted);font-weight:400">(blank = auto)</span></label><input name="due_date" type="date"></div>
        <div class="field"><label>Taxable value (₹) *</label><input name="subtotal" type="number" min="0.01" step="any" required></div>
        ${gstFields}
        ${has('tax') ? `
        <div class="field"><label>Place of Supply${ME.vendor.gstin ? ' *' : ''}</label>
          <select name="place_of_supply_code" ${ME.vendor.gstin ? 'required' : ''}>
            <option value="">— select —</option>
            ${ME.gst_states.map((s) => `<option value="${s.code}" ${s.code === posCode ? 'selected' : ''}>${s.code} — ${esc(s.name)}</option>`).join('')}
          </select></div>
        <div class="field"><label>HSN/SAC Code${ME.vendor.gstin ? ' *' : ''}</label><input name="hsn_sac_code" ${ME.vendor.gstin ? 'required' : ''} placeholder="e.g. 998314"></div>
        <div class="field full"><label>Description <span style="color:var(--text-muted);font-weight:400">(max 50 chars, optional)</span></label>
          <input name="gl_description" maxlength="50"></div>` : ''}
        <div class="field full"><label>Invoice copy (PDF/PNG/JPG, max 5 MB)</label>
          <input name="attachment" type="file" accept=".pdf,.png,.jpg,.jpeg"></div>
      </div>
      ${!overseas && myState ? `<p style="color:var(--text-muted);font-size:12px;margin-top:8px">
        ${intra ? `Intra-state supply to ${esc(po.gstin_label || '')} (${esc(po.company_gstin || '')}) — charge CGST + SGST.`
                : `Inter-state supply to ${esc(po.gstin_label || '')} (${esc(po.company_gstin || '')}) — charge IGST.`}</p>` : ''}
      <p style="color:var(--text-muted);font-size:12.5px;margin-top:10px">
        Goods accepted so far on this PO: <strong>${fmtMoney(receivedValue)}</strong>.
        Your invoice is matched against the PO and accepted receipts before approval.</p>
      <div class="form-actions">
        <button type="button" class="btn" onclick="closeModal()">Cancel</button>
        <button type="submit" class="btn btn-primary">Submit invoice</button>
      </div>
    </form>`);
  $('#vinv-invoice-date').addEventListener('change', (e) => {
    if (!$('#vinv-received-date').value) $('#vinv-received-date').value = e.target.value;
  });
  $('#vinv-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    fd.append('po_id', po.id);
    if (fd.get('attachment') && !fd.get('attachment').name) fd.delete('attachment');
    try {
      const r = await api('/vendor/invoices', { method: 'POST', body: fd });
      toast(`Invoice ${r.invoice_number} submitted${r.match_status === 'mismatch' ? ' — flagged for review' : ''}`,
        r.match_status === 'mismatch' ? 'error' : 'success');
      closeModal();
      activeTab = 'invoices';
      document.querySelectorAll('.portal-tabs button').forEach((x) => x.classList.toggle('active', x.dataset.tab === 'invoices'));
      renderTab();
    } catch (err) { toast(err.message, 'error'); }
  });
}

// ---------- invoices ----------
async function renderInvoices(main) {
  const invoices = await api('/vendor/invoices');
  main.innerHTML = `
    ${verifyBannerHtml()}
    <div class="page-header"><div><h2>My Invoices</h2>
      <div class="sub">Submitted invoices and payment status</div></div></div>
    <div class="card table-wrap"><table>
      <thead><tr><th>Invoice #</th><th>Your ref</th><th>PO #</th><th>Date</th><th class="num">Total</th><th class="num">Paid</th><th>Status</th><th></th></tr></thead>
      <tbody>${invoices.length ? invoices.map((i, idx) => `
        <tr>
          <td><strong>${esc(i.invoice_number)}</strong></td>
          <td>${esc(i.vendor_invoice_ref || '—')}</td>
          <td>${esc(i.po_number)}</td>
          <td>${fmtDate(i.invoice_date)}</td>
          <td class="num">${fmtMoney(i.total)}</td>
          <td class="num">${fmtMoney(i.paid_amount)}</td>
          <td>${badge(i.status)}</td>
          <td><button class="btn btn-sm" data-view="${idx}">Details</button></td>
        </tr>`).join('') : '<tr><td colspan="8" class="empty-state">No invoices submitted yet</td></tr>'}
      </tbody>
    </table></div>`;
  main.querySelectorAll('[data-view]').forEach((b) =>
    b.addEventListener('click', () => showInvoiceDetail(invoices[Number(b.dataset.view)])));
}

function showInvoiceDetail(inv) {
  const netPayable = inv.total - inv.tds_amount;
  const outstanding = netPayable - inv.paid_amount;
  openModal(`${inv.invoice_number}`, `
    <div style="margin-bottom:12px">${badge(inv.status)} ${badge(inv.match_status)}</div>
    <div class="detail-grid">
      <div class="detail-item"><div class="dl">Your reference</div><div class="dv">${esc(inv.vendor_invoice_ref || '—')}</div></div>
      <div class="detail-item"><div class="dl">Against PO</div><div class="dv">${esc(inv.po_number)}</div></div>
      <div class="detail-item"><div class="dl">Invoice date</div><div class="dv">${fmtDate(inv.invoice_date)}</div></div>
      <div class="detail-item"><div class="dl">Invoice Receipt Date</div><div class="dv">${fmtDate(inv.received_date)}</div></div>
      <div class="detail-item"><div class="dl">Due date</div><div class="dv">${fmtDate(inv.due_date)}</div></div>
      <div class="detail-item"><div class="dl">Taxable value</div><div class="dv">${fmtMoney(inv.subtotal)}</div></div>
      ${inv.hsn_sac_code ? `<div class="detail-item"><div class="dl">HSN/SAC Code</div><div class="dv">${esc(inv.hsn_sac_code)}</div></div>` : ''}
      ${inv.place_of_supply_code ? `<div class="detail-item"><div class="dl">Place of Supply</div><div class="dv">${esc(inv.place_of_supply_code)} — ${esc(inv.place_of_supply_state || '')}</div></div>` : ''}
      <div class="detail-item"><div class="dl">GST</div><div class="dv">${inv.rcm ? 'RCM (buyer self-assessed)' : fmtMoney(inv.tax_amount)}</div></div>
      <div class="detail-item"><div class="dl">Invoice total</div><div class="dv">${fmtMoney(inv.total)}</div></div>
      ${inv.tds_amount > 0 ? `
      <div class="detail-item"><div class="dl">TDS deducted (u/s ${esc(inv.tds_section || '')} @ ${inv.tds_rate}%)</div>
        <div class="dv" style="color:var(--red)">− ${fmtMoney(inv.tds_amount)}</div></div>
      <div class="detail-item"><div class="dl">Net payable to you</div><div class="dv">${fmtMoney(netPayable)}</div></div>` : ''}
      <div class="detail-item"><div class="dl">Outstanding</div>
        <div class="dv" style="color:${outstanding > 0.01 ? 'var(--red)' : 'var(--green)'}">${fmtMoney(outstanding)}</div></div>
    </div>
    ${inv.tds_amount > 0 ? `<p style="color:var(--text-muted);font-size:12px;margin-top:4px">
      TDS deducted at source is deposited with the Income Tax Department against your PAN and will reflect in your Form 26AS.</p>` : ''}
    ${inv.match_status === 'mismatch' ? `<div class="form-error">Under review: ${esc(inv.match_notes || '')}</div>` : ''}
    ${inv.attachment_name ? `<div class="detail-item" style="margin-top:10px"><div class="dl">Attachment</div>
      <div class="dv"><a class="link" href="/api/invoices/${inv.id}/attachment?token=${encodeURIComponent(VTOKEN)}" target="_blank">📎 ${esc(inv.attachment_name)}</a></div></div>` : ''}
    ${inv.payments.length ? `<div class="section-title">Payments received</div>
      <div class="table-wrap"><table>
        <thead><tr><th>Payment #</th><th>Date</th><th class="num">Amount</th><th>Method</th><th>Reference</th></tr></thead>
        <tbody>${inv.payments.map((p) => `
          <tr><td>${esc(p.payment_number)}</td><td>${fmtDate(p.payment_date)}</td><td class="num">${fmtMoney(p.amount)}</td>
          <td>${esc(p.method.replace('_', ' '))}</td><td>${esc(p.reference || '—')}</td></tr>`).join('')}</tbody>
      </table></div>` : '<p style="color:var(--text-muted);margin-top:12px">No payments received yet.</p>'}`);
}

// ---------- profile ----------
const VENDOR_DOC_LABELS = {
  pan: 'PAN card', gstin: 'GSTIN certificate', cancelled_cheque: 'Cancelled cheque',
  msme: 'MSME registration certificate', other: 'Other document',
};

async function renderProfile(main) {
  ME = await api('/vendor/me');
  $('#vendor-verify-badge').innerHTML = verificationBadge();
  const docs = await api('/vendor/documents');
  const byType = Object.fromEntries(docs.map((d) => [d.doc_type, d]));
  const overseas = ME.vendor.vendor_type === 'overseas';
  const required = overseas ? []
    : ME.vendor.gstin ? ['pan', 'gstin', 'cancelled_cheque'] : ['pan', 'cancelled_cheque'];
  const v = ME.vendor;
  main.innerHTML = `
    ${verifyBannerHtml()}
    <div class="page-header"><div><h2>Company Profile</h2>
      <div class="sub">Vendor code ${esc(v.code)} · registered ${fmtDate(v.created_at)}</div></div></div>
    <div class="card card-pad">
      <form id="vprofile-form">
        <div class="form-grid">
          <div class="field full"><label>Company name (locked)</label><input value="${esc(v.name)}" disabled></div>
          <div class="field"><label>Contact person</label><input name="contact_person" value="${esc(v.contact_person || '')}"></div>
          <div class="field"><label>Phone</label><input name="phone" value="${esc(v.phone || '')}"></div>
          <div class="field full"><label>Address</label><textarea name="address">${esc(v.address || '')}</textarea></div>
          <div class="field"><label>GSTIN</label><input name="gstin" value="${esc(v.gstin || '')}"></div>
          <div class="field"><label>PAN</label><input name="pan" value="${esc(v.pan || '')}"></div>
          <div class="field"><label>Bank name</label><input name="bank_name" value="${esc(v.bank_name || '')}"></div>
          <div class="field"><label>Account number</label><input name="bank_account" value="${esc(v.bank_account || '')}"></div>
          <div class="field"><label>IFSC</label><input name="ifsc" value="${esc(v.ifsc || '')}"></div>
          <div class="field"><label>Payment terms (set by buyer)</label><input value="Net ${v.payment_terms_days ?? 30} days" disabled></div>
        </div>
        <div class="form-actions"><button type="submit" class="btn btn-primary">Save changes</button></div>
      </form>
    </div>
    <div class="card card-pad" style="margin-top:16px">
      <h4 style="margin-bottom:6px">Verification documents (KYC)</h4>
      <p style="color:var(--text-muted);font-size:12.5px;margin-bottom:12px">
        ${overseas
          ? 'Upload any KYC documents applicable to your company.'
          : `PAN card and a cancelled cheque are <strong>required</strong> before your account can be verified${ME.vendor.gstin
              ? ', and as a GST-registered vendor your GSTIN certificate is required too'
              : ' (GSTIN certificate only applies if you are GST-registered)'}. MSME certificate is optional but ensures MSME payment terms.`}
        PDF, PNG or JPG up to 5 MB. Re-uploading a type replaces the earlier file.</p>
      ${['pan', 'gstin', 'cancelled_cheque', 'msme', 'other'].map((t) => {
        const d = byType[t];
        return `
        <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 0;border-bottom:1px solid var(--border);flex-wrap:wrap">
          <div style="min-width:220px">
            <strong>${esc(VENDOR_DOC_LABELS[t])}</strong>${required.includes(t) ? ' <span style="color:var(--red)">*</span>' : ''}<br>
            ${d ? `<a class="link" style="font-size:12.5px" href="/api/vendors/${v.id}/documents/${d.id}/file?token=${encodeURIComponent(VTOKEN)}" target="_blank">📎 ${esc(d.file_name)}</a>
                   <span style="color:var(--text-muted);font-size:11.5px"> · ${fmtDate(d.created_at)}</span>`
                : `<span style="color:${required.includes(t) ? 'var(--red)' : 'var(--text-muted)'};font-size:12.5px">Not uploaded</span>`}
          </div>
          <form data-doc-upload="${t}" style="display:flex;gap:6px;align-items:center">
            <input type="file" name="file" accept=".pdf,.png,.jpg,.jpeg" style="font-size:12px;max-width:200px">
            <button type="submit" class="btn btn-sm">${d ? 'Replace' : 'Upload'}</button>
          </form>
        </div>`;
      }).join('')}
    </div>
    <div class="card card-pad" style="margin-top:16px">
      <h4 style="margin-bottom:6px">Portal password</h4>
      <p style="color:var(--text-muted);font-size:12.5px;margin-bottom:12px">
        Change the password you use to sign in to this portal (${esc(ME.user.email)}).
        If you have forgotten your password, contact the buyer's finance team — they can reset it for you.</p>
      <form id="vpw-form">
        <div class="form-grid">
          <div class="field"><label>Current password *</label><input name="current_password" type="password" autocomplete="current-password" required></div>
          <div class="field"><label>New password * <span style="color:var(--text-muted);font-weight:400">(min 8 chars, letters + numbers)</span></label>
            <input name="new_password" type="password" autocomplete="new-password" required minlength="8"></div>
        </div>
        <div class="form-actions"><button type="submit" class="btn btn-primary">Change password</button></div>
      </form>
    </div>`;
  $('#vpw-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/vendor/change-password', { method: 'POST', body: Object.fromEntries(new FormData(e.target).entries()) });
      toast('Password changed', 'success');
      e.target.reset();
    } catch (err) { toast(err.message, 'error'); }
  });
  $('#vprofile-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/vendor/profile', { method: 'PUT', body: Object.fromEntries(new FormData(e.target).entries()) });
      toast('Profile updated', 'success');
    } catch (err) { toast(err.message, 'error'); }
  });
  main.querySelectorAll('[data-doc-upload]').forEach((form) =>
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const file = form.querySelector('[name=file]').files[0];
      if (!file) return toast('Choose a file first', 'error');
      const fd = new FormData();
      fd.append('doc_type', form.dataset.docUpload);
      fd.append('file', file);
      try {
        await api('/vendor/documents', { method: 'POST', body: fd });
        toast(`${VENDOR_DOC_LABELS[form.dataset.docUpload]} uploaded`, 'success');
        renderTab();
      } catch (err) { toast(err.message, 'error'); }
    }));
}

// ---------- boot ----------
(async function boot() {
  if (!VTOKEN) return showAuth();
  try { await enterPortal(); }
  catch { /* api() logged out on 401 */ }
})();
