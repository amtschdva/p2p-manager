/* P2P Manager — SPA frontend */
'use strict';

// ---------- state & helpers ----------
let TOKEN = localStorage.getItem('p2p_token');
let USER = JSON.parse(localStorage.getItem('p2p_user') || 'null');
let charts = [];

const $ = (sel, el = document) => el.querySelector(sel);
const fmtMoney = (n) => '₹' + Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtDate = (d) => d ? new Date(d.replace(' ', 'T')).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function api(path, options = {}) {
  const isForm = options.body instanceof FormData;
  const res = await fetch('/api' + path, {
    ...options,
    headers: {
      ...(isForm ? {} : { 'Content-Type': 'application/json' }),
      ...(TOKEN ? { Authorization: 'Bearer ' + TOKEN } : {}),
      ...(options.headers || {}),
    },
    body: isForm ? options.body : options.body ? JSON.stringify(options.body) : undefined,
  });
  if (res.status === 401 && TOKEN) { logout(); throw new Error('Session expired, please sign in again'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

function toast(msg, type = 'info') {
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.textContent = msg;
  $('#toast-container').appendChild(el);
  setTimeout(() => el.remove(), 4200);
}

const STATUS_BADGE = {
  draft: 'gray', submitted: 'blue', approved: 'green', rejected: 'red', converted: 'purple', cancelled: 'gray',
  open: 'blue', sent: 'blue', partially_received: 'amber', received: 'green', closed: 'gray',
  pending: 'amber', partially_paid: 'amber', paid: 'green',
  matched: 'green', mismatch: 'red', unmatched: 'gray',
  active: 'green', inactive: 'gray', blocked: 'red', expired: 'red', exhausted: 'amber', not_yet_valid: 'gray',
  na: 'gray', not_in_2b: 'red', not_in_books: 'red',
  eligible: 'green', ineligible: 'amber', rcm: 'purple',
  invoice_booking: 'blue', payment: 'green', tds_deposit: 'purple', rcm_deposit: 'purple',
};

// cached tax masters (company GSTINs, TDS sections, RCM categories)
let TAXMETA = null;
async function taxMeta() {
  if (!TAXMETA) TAXMETA = await api('/meta/tax');
  return TAXMETA;
}
const badge = (s) => `<span class="badge badge-${STATUS_BADGE[s] || 'gray'}">${esc(String(s).replace(/_/g, ' '))}</span>`;

// role checks (admin can do everything)
const is = (...roles) => USER && (USER.role === 'admin' || roles.includes(USER.role));

// this build has no license-gated modules — every feature is always on
const has = () => true;

// ---------- auth ----------
function logout() {
  TOKEN = null; USER = null;
  localStorage.removeItem('p2p_token');
  localStorage.removeItem('p2p_user');
  showLogin();
}

function showLogin() {
  $('#app-shell').classList.add('hidden');
  $('#login-screen').classList.remove('hidden');
}

function showApp() {
  $('#login-screen').classList.add('hidden');
  $('#app-shell').classList.remove('hidden');
  renderNav();
  route();
}

let TOTP_TEMP_TOKEN = null;

function completeLogin(data) {
  TOKEN = data.token; USER = data.user;
  localStorage.setItem('p2p_token', TOKEN);
  localStorage.setItem('p2p_user', JSON.stringify(USER));
  TOTP_TEMP_TOKEN = null;
  $('#totp-form').classList.add('hidden');
  $('#login-form').classList.remove('hidden');
  location.hash = '#/dashboard';
  showApp();
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errEl = $('#login-error');
  errEl.classList.add('hidden');
  try {
    const data = await api('/auth/login', {
      method: 'POST',
      body: { username: $('#login-username').value, password: $('#login-password').value },
    });
    if (data.totp_required) {
      TOTP_TEMP_TOKEN = data.temp_token;
      $('#login-form').classList.add('hidden');
      $('#totp-form').classList.remove('hidden');
      $('#totp-code').value = '';
      $('#totp-code').focus();
      return;
    }
    completeLogin(data);
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.remove('hidden');
  }
});

$('#totp-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errEl = $('#totp-error');
  errEl.classList.add('hidden');
  try {
    const data = await api('/auth/totp/verify', {
      method: 'POST',
      body: { temp_token: TOTP_TEMP_TOKEN, code: $('#totp-code').value },
    });
    completeLogin(data);
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.remove('hidden');
    if (/expired/i.test(err.message)) $('#totp-back').click();
  }
});

$('#totp-back').addEventListener('click', () => {
  TOTP_TEMP_TOKEN = null;
  $('#totp-form').classList.add('hidden');
  $('#totp-error').classList.add('hidden');
  $('#login-form').classList.remove('hidden');
});

$('#btn-logout').addEventListener('click', logout);

// ---------- theme ----------
// Chart.js draws its own text/grid colors — feed it the active theme's
// palette so dashboard charts stay legible in dark mode.
function applyChartTheme() {
  if (typeof Chart === 'undefined') return;
  const cs = getComputedStyle(document.documentElement);
  Chart.defaults.color = cs.getPropertyValue('--text-muted').trim();
  Chart.defaults.borderColor = cs.getPropertyValue('--border').trim();
  // doughnut/pie segment separators default to white — use the card surface
  // so they blend with the chart's background in either theme
  Chart.defaults.elements.arc.borderColor = cs.getPropertyValue('--surface').trim();
}
applyChartTheme();
$('#btn-theme')?.addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  localStorage.setItem('p2p_theme', next);
  applyChartTheme();
  if (TOKEN) route(); // re-render so charts pick up the new palette
});
$('#btn-change-pw').addEventListener('click', () => openChangePassword());
$('#btn-2fa').addEventListener('click', () => openTotpModal());

// ---------- modal ----------
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

// ---------- nav & router ----------
const PAGES = [
  { hash: '#/dashboard', label: 'Dashboard', icon: '📊', show: () => true },
  { hash: '#/my-approvals', label: 'My Approvals', icon: '✅', show: () => true },
  { hash: '#/vendors', label: 'Vendors (AP)', icon: '🏢', show: () => true },
  { hash: '#/prs', label: 'Requisitions', icon: '📝', show: () => true },
  { hash: '#/pos', label: 'Purchase Orders', icon: '📦', show: () => true },
  { hash: '#/grns', label: 'Goods Receipts', icon: '🚚', show: () => true },
  { hash: '#/invoices', label: 'Invoices', icon: '🧾', show: () => true },
  { hash: '#/payments', label: 'Payments', icon: '💸', show: () => has('payments') },
  { hash: '#/journal', label: 'Journal Entries', icon: '📒', show: () => has('tax') && is('finance', 'approver') },
  { hash: '#/tax', label: 'TDS & RCM', icon: '🏦', show: () => has('tax') && is('finance') },
  { hash: '#/gst-recon', label: 'GST Recon (2B)', icon: '🔄', show: () => has('tax') && is('finance') },
  { hash: '#/statements', label: 'Vendor Statements', icon: '📑', show: () => has('tax') && is('finance', 'procurement') },
  { hash: '#/users', label: 'Users', icon: '👥', show: () => is() /* admin only */ },
  { hash: '#/settings', label: 'Settings', icon: '⚙️', show: () => is() /* admin only */ },
];

function renderNav() {
  $('#nav').innerHTML = PAGES.filter((p) => p.show()).map(
    (p) => `<a href="${p.hash}" data-page="${p.hash}">${p.icon} ${p.label}</a>`
  ).join('');
  $('#user-badge').innerHTML = `${esc(USER.full_name)}<br><span class="role">${esc(USER.role)}</span>`;
}

function setActiveNav() {
  const base = '#/' + (location.hash.split('/')[1] || 'dashboard');
  document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.page === base));
}

async function route() {
  if (!TOKEN) return showLogin();
  charts.forEach((c) => c.destroy());
  charts = [];
  const parts = (location.hash || '#/dashboard').slice(2).split('/');
  const [page, id] = parts;
  setActiveNav();
  const main = $('#main');
  main.innerHTML = '<div class="empty-state">Loading…</div>';
  try {
    if (page === 'vendors') await renderVendors(main);
    else if (page === 'prs' && id) await renderPrDetail(main, id);
    else if (page === 'prs') await renderPrs(main);
    else if (page === 'pos' && id) await renderPoDetail(main, id);
    else if (page === 'pos') await renderPos(main);
    else if (page === 'grns' && id) await renderGrnDetail(main, id);
    else if (page === 'grns') await renderGrns(main);
    else if (page === 'invoices' && id) await renderInvoiceDetail(main, id);
    else if (page === 'invoices') await renderInvoices(main);
    else if (page === 'payments') await renderPayments(main);
    else if (page === 'my-approvals') await renderMyApprovals(main);
    else if (page === 'journal') await renderJournal(main);
    else if (page === 'tax') await renderTax(main);
    else if (page === 'gst-recon') await renderGstRecon(main);
    else if (page === 'statements') await renderStatements(main);
    else if (page === 'settings') await renderSettings(main);
    else if (page === 'users') await renderUsers(main);
    else await renderDashboard(main);
  } catch (err) {
    main.innerHTML = `<div class="card card-pad"><div class="form-error">${esc(err.message)}</div></div>`;
  }
}
window.addEventListener('hashchange', route);

// ---------- dashboard ----------
async function renderDashboard(main) {
  const [d, mine] = await Promise.all([api('/dashboard'), api('/my-approvals')]);
  const k = d.kpis;
  main.innerHTML = `
    <div class="page-header"><div><h2>Dashboard</h2><div class="sub">Procure-to-pay at a glance</div></div></div>
    <div class="kpi-grid">
      <a class="card kpi" href="#/my-approvals" style="text-decoration:none;color:inherit;${mine.total ? 'border-left:4px solid var(--primary)' : ''}">
        <div class="kpi-label">✅ Awaiting your action</div>
        <div class="kpi-value" style="${mine.total ? 'color:var(--primary)' : ''}">${mine.total}</div></a>
      <div class="card kpi"><div class="kpi-label">PRs awaiting approval</div><div class="kpi-value">${k.pending_prs}</div></div>
      <div class="card kpi"><div class="kpi-label">Open POs</div><div class="kpi-value">${k.open_pos}</div></div>
      <div class="card kpi"><div class="kpi-label">Invoices pending</div><div class="kpi-value">${k.pending_invoices}</div></div>
      <div class="card kpi"><div class="kpi-label">Outstanding payable</div><div class="kpi-value money">${fmtMoney(k.outstanding_amount)}</div></div>
      <div class="card kpi"><div class="kpi-label">Paid this month</div><div class="kpi-value money">${fmtMoney(k.paid_this_month)}</div></div>
      <div class="card kpi"><div class="kpi-label">Active vendors</div><div class="kpi-value">${k.active_vendors}</div></div>
      <div class="card kpi"><div class="kpi-label">Vendors to verify</div>
        <div class="kpi-value" style="${k.vendors_to_verify ? 'color:var(--amber)' : ''}">${k.vendors_to_verify}</div></div>
      <div class="card kpi"><div class="kpi-label">GRNs awaiting approval</div>
        <div class="kpi-value" style="${k.pending_grns ? 'color:var(--amber)' : ''}">${k.pending_grns}</div></div>
    </div>
    <div class="chart-grid">
      <div class="card card-pad chart-card"><h4>Spend by vendor</h4><canvas id="ch-vendor"></canvas></div>
      <div class="card card-pad chart-card"><h4>PO status</h4><canvas id="ch-po"></canvas></div>
      <div class="card card-pad chart-card"><h4>Monthly payments</h4><canvas id="ch-monthly"></canvas></div>
      <div class="card card-pad chart-card"><h4>Payables aging (unpaid)</h4><canvas id="ch-aging"></canvas></div>
    </div>
    <div class="card card-pad">
      <h4 style="margin-bottom:8px">Recent activity</h4>
      ${d.recentActivity.length ? d.recentActivity.map((a) => `
        <div class="activity-item">
          <strong>${esc(a.full_name || 'System')}</strong> — ${esc(a.action)} ${esc(a.entity)} ${a.detail ? `<em>${esc(a.detail)}</em>` : ''}
          <div class="when">${fmtDate(a.created_at)}</div>
        </div>`).join('') : '<div class="empty-state">No activity yet</div>'}
    </div>`;

  const palette = ['#2563eb', '#16a34a', '#d97706', '#dc2626', '#7c3aed', '#0891b2', '#db2777', '#65a30d'];
  charts.push(new Chart($('#ch-vendor'), {
    type: 'bar',
    data: {
      labels: d.spendByVendor.map((r) => r.name),
      datasets: [{ data: d.spendByVendor.map((r) => r.total), backgroundColor: '#2563eb', borderRadius: 6 }],
    },
    options: { indexAxis: 'y', plugins: { legend: { display: false } }, scales: { x: { ticks: { callback: (v) => '₹' + (v / 1000) + 'k' } } } },
  }));
  charts.push(new Chart($('#ch-po'), {
    type: 'doughnut',
    data: {
      labels: d.poByStatus.map((r) => r.status.replace(/_/g, ' ')),
      datasets: [{ data: d.poByStatus.map((r) => r.count), backgroundColor: palette }],
    },
    options: { plugins: { legend: { position: 'right' } } },
  }));
  charts.push(new Chart($('#ch-monthly'), {
    type: 'line',
    data: {
      labels: d.monthlyPayments.map((r) => r.month),
      datasets: [{ data: d.monthlyPayments.map((r) => r.total), borderColor: '#16a34a', backgroundColor: 'rgba(22,163,74,0.12)', fill: true, tension: 0.35 }],
    },
    options: { plugins: { legend: { display: false } }, scales: { y: { ticks: { callback: (v) => '₹' + (v / 1000) + 'k' } } } },
  }));
  const agingOrder = ['Not due', '1-30 days', '31-60 days', '60+ days'];
  const aging = agingOrder.map((b) => ({ bucket: b, amount: (d.invoiceAging.find((r) => r.bucket === b) || {}).amount || 0 }));
  charts.push(new Chart($('#ch-aging'), {
    type: 'bar',
    data: {
      labels: aging.map((r) => r.bucket),
      datasets: [{ data: aging.map((r) => r.amount), backgroundColor: ['#16a34a', '#d97706', '#ea580c', '#dc2626'], borderRadius: 6 }],
    },
    options: { plugins: { legend: { display: false } }, scales: { y: { ticks: { callback: (v) => '₹' + (v / 1000) + 'k' } } } },
  }));
}

// ---------- vendors ----------
const VENDOR_DOC_LABELS = {
  pan: 'PAN card', gstin: 'GSTIN certificate', cancelled_cheque: 'Cancelled cheque',
  msme: 'MSME certificate', other: 'Other document',
};

async function renderVendors(main) {
  const vendors = await api('/vendors');
  const canEdit = is('procurement', 'finance');
  const canVerify = is('finance');
  main.innerHTML = `
    <div class="page-header">
      <div><h2>Vendors — AP Master</h2><div class="sub">Supplier master data with bank, tax &amp; KYC documents</div></div>
      <button class="btn btn-primary" id="btn-new-vendor">+ New vendor</button>
    </div>
    <div class="toolbar"><input type="search" id="vendor-search" placeholder="Search name, code, GSTIN…"></div>
    <div id="verify-queue"></div>
    <div class="card table-wrap"><table>
      <thead><tr><th>Code</th><th>Name</th><th>Contact</th><th>GSTIN</th><th>PAN</th><th>Bank</th><th>Terms</th><th>Verified</th><th>Status</th><th></th></tr></thead>
      <tbody id="vendor-rows"></tbody>
    </table></div>`;

  const docChips = (v) => ['pan', 'gstin', 'cancelled_cheque', 'msme'].map((t) => {
    const has = (v.documents || []).includes(t);
    const optional = t === 'msme' || v.vendor_type === 'overseas' || (t === 'gstin' && !v.gstin);
    return `<span class="badge badge-${has ? 'green' : optional ? 'gray' : 'red'}" title="${esc(VENDOR_DOC_LABELS[t])}">
      ${has ? '✓' : optional ? '·' : '✗'} ${esc(VENDOR_DOC_LABELS[t])}</span>`;
  }).join(' ');

  const pendingVerification = vendors.filter((v) => !v.verified && v.status !== 'blocked');
  if (pendingVerification.length) {
    $('#verify-queue').innerHTML = `
      <div class="card card-pad" style="margin-bottom:14px;border-left:4px solid var(--amber)">
        <h4 style="margin-bottom:10px">⏳ Vendors awaiting finance verification (${pendingVerification.length})</h4>
        ${pendingVerification.map((v) => `
          <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding:9px 0;border-bottom:1px solid var(--border);flex-wrap:wrap">
            <div>
              <strong>${esc(v.name)}</strong> ${v.vendor_type === 'overseas' ? '🌏' : ''} · ${esc(v.contact_person || '')} · ${esc(v.email || '')}<br>
              <span style="color:var(--text-muted);font-size:12.5px">
                GSTIN: ${esc(v.gstin || '—')} · PAN: ${esc(v.pan || '—')} ·
                Bank: ${v.bank_name ? `${esc(v.bank_name)} A/c ${esc(v.bank_account || '')} (${esc(v.ifsc || '')})` : '—'}
              </span><br>
              <span style="display:inline-flex;gap:5px;flex-wrap:wrap;margin-top:5px">${docChips(v)}</span>
            </div>
            <div style="display:flex;gap:8px">
              <button class="btn btn-sm" data-docs-vendor="${v.id}">📄 Documents</button>
              ${canVerify ? `
                <button class="btn btn-sm btn-danger" data-reject-vendor="${v.id}">Reject</button>
                <button class="btn btn-sm btn-success" data-verify-vendor="${v.id}">Verify &amp; activate</button>` : ''}
            </div>
          </div>`).join('')}
        ${canVerify ? '' : '<p style="color:var(--text-muted);font-size:12px;margin-top:8px">Only finance can verify vendors — upload any missing documents so they can.</p>'}
      </div>`;
    $('#verify-queue').querySelectorAll('[data-verify-vendor]').forEach((b) =>
      b.addEventListener('click', () => openVerifyVendorModal(vendors.find((x) => x.id === Number(b.dataset.verifyVendor)))));
    $('#verify-queue').querySelectorAll('[data-reject-vendor]').forEach((b) =>
      b.addEventListener('click', async () => {
        const reason = prompt('Reason for rejecting this registration (optional):') ?? '';
        try { await api(`/vendors/${b.dataset.rejectVendor}/reject-verification`, { method: 'POST', body: { reason } }); toast('Registration rejected', 'success'); route(); }
        catch (err) { toast(err.message, 'error'); }
      }));
    $('#verify-queue').querySelectorAll('[data-docs-vendor]').forEach((b) =>
      b.addEventListener('click', () => {
        const v = vendors.find((x) => x.id === Number(b.dataset.docsVendor));
        openVendorDocsModal(v);
      }));
  }

  const draw = (list) => {
    $('#vendor-rows').innerHTML = list.length ? list.map((v) => `
      <tr>
        <td>${esc(v.code)}</td>
        <td class="wrap"><strong>${esc(v.name)}</strong>${v.active_tds_certificates ? ` <span class="badge badge-green" title="Has an active lower/nil TDS certificate">🎫 LDC</span>` : ''}${v.email ? `<br><span style="color:var(--text-muted);font-size:12px">${esc(v.email)}</span>` : ''}</td>
        <td>${esc(v.contact_person || '—')}<br><span style="color:var(--text-muted);font-size:12px">${esc(v.phone || '')}</span></td>
        <td>${esc(v.gstin || '—')}</td>
        <td>${esc(v.pan || '—')}</td>
        <td class="wrap">${v.bank_name ? `${esc(v.bank_name)}<br><span style="color:var(--text-muted);font-size:12px">A/c ${esc(v.bank_account || '')} · ${esc(v.ifsc || '')}</span>` : '—'}</td>
        <td>${esc(v.payment_terms || '—')}</td>
        <td>${v.verified ? badge('matched').replace('matched', 'yes') : badge('pending')}</td>
        <td>${badge(v.status)}</td>
        <td style="white-space:nowrap">
          <button class="btn btn-sm" data-row-docs="${v.id}">📄</button>
          ${has('tax') && is('finance') ? `<button class="btn btn-sm" title="Lower/nil TDS certificates" data-row-tds="${v.id}">🎫</button>` : ''}
          ${canVerify ? `<button class="btn btn-sm" title="Reset vendor portal password" data-row-key="${v.id}">🔑</button>` : ''}
          ${canEdit ? `<button class="btn btn-sm" onclick='openVendorForm(${JSON.stringify(v).replace(/'/g, "&#39;")})'>Edit</button>` : ''}
        </td>
      </tr>`).join('') : `<tr><td colspan="10" class="empty-state">No vendors found</td></tr>`;
    $('#vendor-rows').querySelectorAll('[data-row-docs]').forEach((b) =>
      b.addEventListener('click', () => openVendorDocsModal(vendors.find((x) => x.id === Number(b.dataset.rowDocs)))));
    $('#vendor-rows').querySelectorAll('[data-row-tds]').forEach((b) =>
      b.addEventListener('click', () => openVendorTdsCertsModal(vendors.find((x) => x.id === Number(b.dataset.rowTds)))));
    $('#vendor-rows').querySelectorAll('[data-row-key]').forEach((b) =>
      b.addEventListener('click', () => openPortalPasswordModal(vendors.find((x) => x.id === Number(b.dataset.rowKey)))));
  };
  draw(vendors);
  $('#vendor-search').addEventListener('input', (e) => {
    const q = e.target.value.toLowerCase();
    draw(vendors.filter((v) => [v.name, v.code, v.gstin, v.pan, v.contact_person].join(' ').toLowerCase().includes(q)));
  });
  $('#btn-new-vendor').addEventListener('click', () => openVendorForm(null));
}

// finance assigns the vendor's AP account code (its GL control account) as
// part of activating it — every vendor needs exactly one, and it flows onto
// every journal line booked for that vendor from here on
async function openVerifyVendorModal(vendor) {
  const meta = has('tax') ? await taxMeta() : null;
  const takenApCodes = meta ? new Map((await api('/vendors'))
    .filter((x) => x.id !== vendor.id && x.ap_account_code).map((x) => [x.ap_account_code, x.name])) : new Map();
  openModal(`Verify & activate — ${vendor.name}`, `
    <p style="color:var(--text-muted);font-size:12.5px;margin-bottom:14px">
      Verifying activates this vendor for POs and portal invoicing.
      ${meta ? 'Assign its AP account code now — this is the GL control account that every journal entry for this vendor will post to.' : ''}</p>
    <form id="verify-vendor-form">
      ${meta ? `<div class="field"><label>AP account code *</label>
        <select name="ap_account_code" required>
          <option value="">— select —</option>
          ${meta.ap_account_codes.map((c) => {
            const takenBy = takenApCodes.get(c.code);
            const label = takenBy ? `${c.code} — ${c.name} (assigned to ${takenBy})` : `${c.code} — ${c.name}`;
            return `<option value="${esc(c.code)}" ${vendor.ap_account_code === c.code ? 'selected' : ''} ${takenBy ? 'disabled' : ''}>${esc(label)}</option>`;
          }).join('')}
        </select>
        ${meta.ap_account_codes.length ? '' : '<p style="color:var(--red,#dc2626);font-size:12px;margin-top:6px">No AP account codes exist yet — add one under Settings → GL reference masters first.</p>'}
      </div>` : ''}
      <div class="form-actions">
        <button type="button" class="btn" onclick="closeModal()">Cancel</button>
        <button type="submit" class="btn btn-primary">Verify &amp; activate</button>
      </div>
    </form>`);
  $('#verify-vendor-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(e.target).entries());
    try {
      await api(`/vendors/${vendor.id}/verify`, { method: 'POST', body });
      toast('Vendor verified and activated', 'success');
      closeModal();
      route();
    } catch (err) { toast(err.message, 'error'); }
  });
}

// vendor forgot their portal password — finance sets a new one here
function openPortalPasswordModal(vendor) {
  openModal(`Reset portal password — ${vendor.name}`, `
    <form id="portal-pw-form">
      <p style="color:var(--text-muted);font-size:12.5px;margin-bottom:12px">
        Sets a new sign-in password for this vendor's portal account. Share it with the vendor over a
        trusted channel — they should change it after signing in (Company Profile → Portal password).
        The vendor is notified by email that a reset happened.</p>
      <div class="form-grid">
        <div class="field full"><label>Portal login email <span style="color:var(--text-muted);font-weight:400">(only needed if the vendor has several logins)</span></label>
          <input name="email" type="email" placeholder="${esc(vendor.email || 'vendor login email')}"></div>
        <div class="field full"><label>New password * <span style="color:var(--text-muted);font-weight:400">(min 8 chars, letters + numbers)</span></label>
          <input name="new_password" type="text" required minlength="8" autocomplete="off"></div>
      </div>
      <div class="form-actions">
        <button type="button" class="btn" onclick="closeModal()">Cancel</button>
        <button type="submit" class="btn btn-primary">Reset password</button>
      </div>
    </form>`);
  $('#portal-pw-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target).entries());
    try {
      const r = await api(`/vendors/${vendor.id}/portal-password`, { method: 'POST', body: f });
      toast(`Password reset for ${r.email} — share it with the vendor securely`, 'success');
      closeModal();
    } catch (err) { toast(err.message, 'error'); }
  });
}

// KYC documents modal: view/download and upload per document type
async function openVendorDocsModal(vendor) {
  const docs = await api(`/vendors/${vendor.id}/documents`);
  const byType = Object.fromEntries(docs.map((d) => [d.doc_type, d]));
  const required = vendor.vendor_type === 'overseas' ? []
    : vendor.gstin ? ['pan', 'gstin', 'cancelled_cheque'] : ['pan', 'cancelled_cheque'];
  openModal(`KYC documents — ${vendor.name}`, `
    <p style="color:var(--text-muted);font-size:12.5px;margin-bottom:14px">
      ${vendor.vendor_type === 'overseas'
        ? 'Overseas vendor — no documents are mandatory, but upload whatever KYC you have.'
        : `PAN and cancelled cheque are <strong>required</strong> before finance can verify this vendor${vendor.gstin
            ? ', and since this vendor has a GSTIN, the GSTIN certificate is required too'
            : ' (no GSTIN on record — the GSTIN certificate is not required)'}. MSME certificate is optional.`}
      Uploading a type again replaces the previous file.</p>
    ${['pan', 'gstin', 'cancelled_cheque', 'msme', 'other'].map((t) => {
      const d = byType[t];
      return `
      <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 0;border-bottom:1px solid var(--border);flex-wrap:wrap">
        <div style="min-width:210px">
          <strong>${esc(VENDOR_DOC_LABELS[t])}</strong>${required.includes(t) ? ' <span style="color:var(--red)">*</span>' : ''}<br>
          ${d ? `<a class="link" style="font-size:12.5px" href="/api/vendors/${vendor.id}/documents/${d.id}/file?token=${encodeURIComponent(TOKEN)}" target="_blank">📎 ${esc(d.file_name)}</a>
                 <span style="color:var(--text-muted);font-size:11.5px"> · ${esc(d.uploaded_by_name || d.uploaded_by_vendor_name || '')} · ${fmtDate(d.created_at)}</span>`
              : `<span style="color:${required.includes(t) ? 'var(--red)' : 'var(--text-muted)'};font-size:12.5px">Not uploaded</span>`}
        </div>
        <form data-doc-upload="${t}" style="display:flex;gap:6px;align-items:center">
          <input type="file" name="file" accept=".pdf,.png,.jpg,.jpeg" style="font-size:12px;max-width:210px">
          <button type="submit" class="btn btn-sm">${d ? 'Replace' : 'Upload'}</button>
        </form>
      </div>`;
    }).join('')}
    <div class="form-actions"><button type="button" class="btn" onclick="closeModal()">Close</button></div>`);
  document.querySelectorAll('[data-doc-upload]').forEach((form) =>
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const file = form.querySelector('[name=file]').files[0];
      if (!file) return toast('Choose a file first', 'error');
      const fd = new FormData();
      fd.append('doc_type', form.dataset.docUpload);
      fd.append('file', file);
      try {
        await api(`/vendors/${vendor.id}/documents`, { method: 'POST', body: fd });
        toast(`${VENDOR_DOC_LABELS[form.dataset.docUpload]} uploaded`, 'success');
        openVendorDocsModal(vendor);
      } catch (err) { toast(err.message, 'error'); }
    }));
}
window.openVendorDocsModal = openVendorDocsModal;

// Lower/nil-TDS deduction certificates — list + upload. At final invoice
// approval, a certificate valid on the invoice date suggests its rate.
// a certificate can stop applying for three distinct reasons — surface which
// one, rather than just "inactive", so finance knows whether to renew it,
// wait for it to start, or ask the vendor for a fresh higher-threshold one
function certEffectiveStatus(c) {
  if (!c.active) return 'inactive';
  if (c.is_expired) return 'expired';
  if (c.is_not_yet_valid) return 'not_yet_valid';
  if (c.is_exhausted) return 'exhausted';
  return 'active';
}

async function openVendorTdsCertsModal(vendor) {
  const certs = await api(`/vendors/${vendor.id}/tds-certificates`);
  openModal(`Lower/nil TDS certificates — ${vendor.name}`, `
    <p style="color:var(--text-muted);font-size:12.5px;margin-bottom:14px">
      When a certificate is valid for a section on the invoice date, finance sees its rate suggested
      at final approval instead of the section's standard rate. If it has a threshold, the lower rate
      applies only until invoices booked against it reach that amount, or its validity ends — whichever comes first.</p>
    <div class="table-wrap" style="margin-bottom:16px"><table>
      <thead><tr><th>Section</th><th>Certificate #</th><th class="num">Rate %</th><th>Valid</th><th>Threshold</th><th>File</th><th>Status</th><th></th></tr></thead>
      <tbody>${certs.length ? certs.map((c) => `
        <tr>
          <td>${esc(c.tds_section)}</td><td>${esc(c.certificate_number)}</td><td class="num">${c.rate}</td>
          <td>${fmtDate(c.valid_from)} – ${fmtDate(c.valid_to)}</td>
          <td>${c.threshold_amount != null
            ? `${fmtMoney(c.remaining_amount)} left of ${fmtMoney(c.threshold_amount)}`
            : `<span style="color:var(--text-muted)">No cap (${fmtMoney(c.utilized_amount)} used)</span>`}</td>
          <td>${c.file_path ? `<a class="link" href="/api/vendors/${vendor.id}/tds-certificates/${c.id}/file?token=${encodeURIComponent(TOKEN)}" target="_blank">📎 view</a>` : '—'}</td>
          <td>${badge(certEffectiveStatus(c))}</td>
          <td><button class="btn btn-sm" data-toggle-cert="${c.id}" data-active="${c.active}">${c.active ? 'Deactivate' : 'Activate'}</button></td>
        </tr>`).join('') : '<tr><td colspan="8" class="empty-state">No certificates on file</td></tr>'}
      </tbody>
    </table></div>
    <h4 style="margin-bottom:8px">Add a certificate</h4>
    <form id="tds-cert-form">
      <div class="form-grid">
        <div class="field"><label>TDS section *</label><input name="tds_section" required placeholder="e.g. 194C"></div>
        <div class="field"><label>Certificate number *</label><input name="certificate_number" required></div>
        <div class="field"><label>Lower rate (%) *</label><input name="rate" type="number" min="0" max="40" step="any" required></div>
        <div class="field"><label>Threshold amount (₹) <span style="color:var(--text-muted);font-weight:400">(optional — blank = no cap)</span></label>
          <input name="threshold_amount" type="number" min="0" step="any"></div>
        <div class="field"><label>Valid from *</label><input name="valid_from" type="date" required></div>
        <div class="field"><label>Valid to *</label><input name="valid_to" type="date" required></div>
        <div class="field"><label>Certificate file (PDF/PNG/JPG) *</label><input name="file" type="file" accept=".pdf,.png,.jpg,.jpeg" required></div>
      </div>
      <div class="form-actions">
        <button type="button" class="btn" onclick="closeModal()">Close</button>
        <button type="submit" class="btn btn-primary">Add certificate</button>
      </div>
    </form>`);
  document.querySelectorAll('[data-toggle-cert]').forEach((b) => b.addEventListener('click', () =>
    api(`/vendors/${vendor.id}/tds-certificates/${b.dataset.toggleCert}`, { method: 'PUT', body: { active: b.dataset.active === '1' ? 0 : 1 } })
      .then(() => openVendorTdsCertsModal(vendor)).catch((err) => toast(err.message, 'error'))));
  $('#tds-cert-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await api(`/vendors/${vendor.id}/tds-certificates`, { method: 'POST', body: fd });
      toast('Certificate added', 'success');
      openVendorTdsCertsModal(vendor);
    } catch (err) { toast(err.message, 'error'); }
  });
}
window.openVendorTdsCertsModal = openVendorTdsCertsModal;

window.openVendorForm = async function (v) {
  const isEdit = !!v;
  v = v || {};
  const meta = has('tax') ? await taxMeta() : null;
  // every vendor's AP code must be unique — grey out codes other vendors already hold
  const takenApCodes = meta ? new Map((await api('/vendors'))
    .filter((x) => x.id !== v.id && x.ap_account_code).map((x) => [x.ap_account_code, x.name])) : new Map();
  openModal(isEdit ? `Edit vendor — ${v.name}` : 'New vendor', `
    <form id="vendor-form">
      <div class="form-grid">
        <div class="field full"><label>Vendor name *</label><input name="name" required value="${esc(v.name || '')}"></div>
        <div class="field"><label>Vendor type</label>
          <select name="vendor_type">
            <option value="domestic" ${v.vendor_type !== 'overseas' ? 'selected' : ''}>Domestic (India)</option>
            <option value="overseas" ${v.vendor_type === 'overseas' ? 'selected' : ''}>Overseas (RCM applies)</option>
          </select></div>
        <div class="field"><label>Contact person</label><input name="contact_person" value="${esc(v.contact_person || '')}"></div>
        <div class="field"><label>Email</label><input name="email" type="email" value="${esc(v.email || '')}"></div>
        <div class="field"><label>Phone</label><input name="phone" value="${esc(v.phone || '')}"></div>
        ${isEdit ? `<div class="field"><label>Status</label>
          <select name="status">
            ${['active', 'inactive', 'blocked'].map((s) => `<option value="${s}" ${v.status === s ? 'selected' : ''}>${s}</option>`).join('')}
          </select></div>` : `<div class="field"><label>Status</label>
          <input value="Pending finance verification" disabled></div>`}
        <div class="field full"><label>Address</label><textarea name="address">${esc(v.address || '')}</textarea></div>
        <div class="field"><label>GSTIN</label><input name="gstin" value="${esc(v.gstin || '')}" placeholder="e.g. 29AABCT1234F1Z5"></div>
        <div class="field"><label>PAN</label><input name="pan" value="${esc(v.pan || '')}" placeholder="e.g. AABCT1234F"></div>
        <div class="field"><label>Bank name</label><input name="bank_name" value="${esc(v.bank_name || '')}"></div>
        <div class="field"><label>Account number</label><input name="bank_account" value="${esc(v.bank_account || '')}"></div>
        <div class="field"><label>IFSC</label><input name="ifsc" value="${esc(v.ifsc || '')}"></div>
        <div class="field"><label>Payment terms (days)</label>
          <input name="payment_terms_days" type="number" min="0" max="365" value="${v.payment_terms_days ?? 30}">
          <span style="color:var(--text-muted);font-size:11.5px">Due date = Invoice Receipt Date + this many days</span></div>
        ${meta ? `<div class="field"><label>AP account code <span style="color:var(--text-muted);font-weight:400">(unique per vendor, for GL export)</span></label>
          <select name="ap_account_code">
            <option value="">— none —</option>
            ${meta.ap_account_codes.map((c) => {
              const takenBy = takenApCodes.get(c.code);
              const label = takenBy ? `${c.code} — ${c.name} (assigned to ${takenBy})` : `${c.code} — ${c.name}`;
              return `<option value="${esc(c.code)}" ${v.ap_account_code === c.code ? 'selected' : ''} ${takenBy ? 'disabled' : ''}>${esc(label)}</option>`;
            }).join('')}
          </select></div>` : ''}
      </div>
      ${isEdit && meta && is('finance') ? `<p style="margin-top:4px">
        <button type="button" class="btn btn-sm" id="btn-vendor-tds-certs">🎫 Lower/nil TDS certificates</button></p>` : ''}
      <div class="form-actions">
        <button type="button" class="btn" onclick="closeModal()">Cancel</button>
        <button type="submit" class="btn btn-primary">${isEdit ? 'Save changes' : 'Create vendor'}</button>
      </div>
    </form>`);
  if (isEdit && meta && is('finance')) {
    $('#btn-vendor-tds-certs').addEventListener('click', () => openVendorTdsCertsModal(v));
  }
  $('#vendor-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(e.target).entries());
    try {
      if (isEdit) {
        await api('/vendors/' + v.id, { method: 'PUT', body });
        toast('Vendor updated', 'success');
        closeModal(); route();
      } else {
        const r = await api('/vendors', { method: 'POST', body });
        toast('Vendor created — now attach the KYC documents', 'success');
        closeModal(); route();
        openVendorDocsModal({ id: r.id, name: body.name, vendor_type: body.vendor_type || 'domestic', gstin: body.gstin || '' });
      }
    } catch (err) { toast(err.message, 'error'); }
  });
};

// ---------- line-item editor (shared by PR & PO forms) ----------
function itemsEditorHtml(priceLabel) {
  return `
    <div class="items-editor">
      <h4>Line items</h4>
      <div class="items-header"><span>Description</span><span>Qty</span><span>Unit</span><span>${priceLabel}</span><span></span></div>
      <div id="item-rows"></div>
      <button type="button" class="btn btn-sm" id="btn-add-item">+ Add line</button>
    </div>`;
}
function addItemRow(item = {}) {
  const row = document.createElement('div');
  row.className = 'item-row';
  row.innerHTML = `
    <input name="description" placeholder="Item description" required value="${esc(item.description || '')}">
    <input name="quantity" type="number" min="0.01" step="any" placeholder="Qty" required value="${item.quantity || ''}">
    <input name="unit" placeholder="EA" value="${esc(item.unit || 'EA')}">
    <input name="price" type="number" min="0" step="any" placeholder="0.00" value="${item.price ?? ''}">
    <button type="button" class="remove-item" title="Remove">&times;</button>`;
  row.querySelector('.remove-item').addEventListener('click', () => row.remove());
  $('#item-rows').appendChild(row);
}
function readItems(priceKey) {
  return [...document.querySelectorAll('#item-rows .item-row')].map((r) => ({
    description: r.querySelector('[name=description]').value.trim(),
    quantity: Number(r.querySelector('[name=quantity]').value),
    unit: r.querySelector('[name=unit]').value.trim() || 'EA',
    [priceKey]: Number(r.querySelector('[name=price]').value) || 0,
  }));
}

// live "who will approve this?" preview used by the PR and invoice forms
function attachChainPreview(containerId, docType, getDeptId, getAmount) {
  const el = $(containerId);
  if (!el) return () => {};
  let timer = null;
  const refresh = () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      try {
        const chain = await api(`/approvals/preview?doc_type=${docType}&department_id=${getDeptId() || ''}&amount=${getAmount() || 0}`);
        el.innerHTML = `<strong>Approval chain:</strong> ` +
          chain.map((c) => `${c.seq}. ${esc(c.label)}`).join(' <span style="color:var(--text-muted)">→</span> ');
      } catch { el.textContent = ''; }
    }, 250);
  };
  refresh();
  return refresh;
}

// ---------- purchase requisitions ----------
async function renderPrs(main) {
  const prs = await api('/prs');
  main.innerHTML = `
    <div class="page-header">
      <div><h2>Purchase Requisitions</h2><div class="sub">Request goods &amp; services for approval</div></div>
      <button class="btn btn-primary" id="btn-new-pr">+ New requisition</button>
    </div>
    <div class="toolbar">
      <select id="pr-filter">
        <option value="">All statuses</option>
        ${['submitted', 'approved', 'rejected', 'converted'].map((s) => `<option value="${s}">${s}</option>`).join('')}
      </select>
    </div>
    <div class="card table-wrap"><table>
      <thead><tr><th>PR #</th><th>Requester</th><th>Department</th><th>Needed by</th><th class="num">Est. total</th><th>Status</th><th>Approver</th></tr></thead>
      <tbody id="pr-rows"></tbody>
    </table></div>`;
  const draw = (list) => {
    $('#pr-rows').innerHTML = list.length ? list.map((p) => `
      <tr>
        <td><a class="link" href="#/prs/${p.id}">${esc(p.pr_number)}</a></td>
        <td>${esc(p.requester_name)}</td>
        <td>${esc(p.department_name || p.department || '—')}</td>
        <td>${fmtDate(p.needed_by)}</td>
        <td class="num">${fmtMoney(p.estimated_total)}</td>
        <td>${badge(p.status)}${p.awaiting ? `<div style="font-size:11px;color:var(--text-muted)">awaiting ${esc(p.awaiting)}</div>` : ''}</td>
        <td>${esc(p.approver_name || '—')}</td>
      </tr>`).join('') : '<tr><td colspan="7" class="empty-state">No requisitions</td></tr>';
  };
  draw(prs);
  $('#pr-filter').addEventListener('change', (e) => draw(e.target.value ? prs.filter((p) => p.status === e.target.value) : prs));
  $('#btn-new-pr').addEventListener('click', openPrForm);
}

async function openPrForm() {
  const meta = await taxMeta();
  const me = await api('/auth/me');
  openModal('New purchase requisition', `
    <form id="pr-form">
      <div class="form-grid">
        <div class="field"><label>Department</label>
          <select name="department_id">
            <option value="">— none —</option>
            ${meta.departments.map((d) => `<option value="${d.id}" ${d.id === me.department_id ? 'selected' : ''}>${esc(d.name)}${d.head_name ? ` (head: ${esc(d.head_name)})` : ''}</option>`).join('')}
          </select></div>
        <div class="field"><label>Needed by</label><input name="needed_by" type="date"></div>
        <div class="field full"><label>Justification</label><textarea name="justification" placeholder="Why is this purchase needed?"></textarea></div>
      </div>
      ${itemsEditorHtml('Est. unit price')}
      <div id="pr-chain-preview" style="background:var(--bg);border-radius:8px;padding:9px 12px;margin-top:12px;font-size:12.5px"></div>
      <div class="form-actions">
        <button type="button" class="btn" onclick="closeModal()">Cancel</button>
        <button type="submit" class="btn btn-primary">Submit requisition</button>
      </div>
    </form>`);
  addItemRow();
  const estTotal = () => readItems('est_unit_price').reduce((t, i) => t + (i.quantity || 0) * (i.est_unit_price || 0), 0);
  const refreshChain = attachChainPreview('#pr-chain-preview', 'pr',
    () => $('#pr-form [name=department_id]').value, estTotal);
  $('#pr-form [name=department_id]').addEventListener('change', refreshChain);
  $('#item-rows').addEventListener('input', refreshChain);
  $('#btn-add-item').addEventListener('click', () => addItemRow());
  $('#pr-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target).entries());
    try {
      const r = await api('/prs', {
        method: 'POST',
        body: { department_id: f.department_id, needed_by: f.needed_by, justification: f.justification, items: readItems('est_unit_price') },
      });
      toast(`${r.pr_number} submitted for approval`, 'success');
      closeModal(); route();
    } catch (err) { toast(err.message, 'error'); }
  });
}

// shared approval-chain renderer (PR & invoice detail pages)
function chainHtml(chain) {
  if (!chain || !chain.length) return '';
  return `
    <div class="section-title">Approval chain</div>
    <div class="table-wrap"><table>
      <thead><tr><th>Level</th><th>Approver</th><th>Status</th><th>Acted by</th><th>When</th><th>Comment</th></tr></thead>
      <tbody>${chain.map((s) => `
        <tr>
          <td>${s.seq}</td>
          <td>${esc(s.label)}</td>
          <td>${badge(s.status)}</td>
          <td>${esc(s.acted_by_name || '—')}</td>
          <td>${s.acted_at ? fmtDate(s.acted_at) : '—'}</td>
          <td class="wrap">${esc(s.comment || '—')}</td>
        </tr>`).join('')}
      </tbody>
    </table></div>`;
}

async function renderPrDetail(main, id) {
  const pr = await api('/prs/' + id);
  const total = pr.items.reduce((s, i) => s + i.quantity * i.est_unit_price, 0);
  const canApprove = !!pr.can_act;
  const canConvert = is('procurement') && pr.status === 'approved';
  main.innerHTML = `
    <div class="page-header">
      <div><h2>${esc(pr.pr_number)} ${badge(pr.status)}</h2><div class="sub">Raised by ${esc(pr.requester_name)} on ${fmtDate(pr.created_at)}</div></div>
      <div style="display:flex;gap:8px">
        <a class="btn" href="#/prs">← Back</a>
        ${canApprove ? `<button class="btn btn-danger" id="btn-reject-pr">Reject</button><button class="btn btn-success" id="btn-approve-pr">Approve</button>` : ''}
        ${canConvert ? `<button class="btn btn-primary" id="btn-convert-pr">Convert to PO →</button>` : ''}
      </div>
    </div>
    <div class="card card-pad">
      <div class="detail-grid">
        <div class="detail-item"><div class="dl">Department</div><div class="dv">${esc(pr.department_name || pr.department || '—')}</div></div>
        <div class="detail-item"><div class="dl">Needed by</div><div class="dv">${fmtDate(pr.needed_by)}</div></div>
        <div class="detail-item"><div class="dl">Approver</div><div class="dv">${esc(pr.approver_name || 'Pending')}</div></div>
        <div class="detail-item"><div class="dl">Estimated total</div><div class="dv">${fmtMoney(total)}</div></div>
      </div>
      ${pr.justification ? `<div class="detail-item"><div class="dl">Justification</div><div class="dv" style="font-weight:400">${esc(pr.justification)}</div></div>` : ''}
      ${pr.rejection_reason ? `<div class="form-error">Rejected: ${esc(pr.rejection_reason)}</div>` : ''}
      <div class="section-title">Items</div>
      <div class="table-wrap"><table>
        <thead><tr><th>Description</th><th class="num">Qty</th><th>Unit</th><th class="num">Est. price</th><th class="num">Est. amount</th></tr></thead>
        <tbody>${pr.items.map((i) => `
          <tr><td class="wrap">${esc(i.description)}</td><td class="num">${i.quantity}</td><td>${esc(i.unit)}</td>
          <td class="num">${fmtMoney(i.est_unit_price)}</td><td class="num">${fmtMoney(i.quantity * i.est_unit_price)}</td></tr>`).join('')}
        </tbody>
      </table></div>
      ${chainHtml(pr.approval_chain)}
    </div>`;
  if (canApprove) {
    $('#btn-approve-pr').addEventListener('click', async () => {
      try { await api(`/prs/${pr.id}/approve`, { method: 'POST' }); toast('PR approved', 'success'); route(); }
      catch (err) { toast(err.message, 'error'); }
    });
    $('#btn-reject-pr').addEventListener('click', async () => {
      const reason = prompt('Reason for rejection (optional):') ?? '';
      try { await api(`/prs/${pr.id}/reject`, { method: 'POST', body: { reason } }); toast('PR rejected', 'success'); route(); }
      catch (err) { toast(err.message, 'error'); }
    });
  }
  if (canConvert) $('#btn-convert-pr').addEventListener('click', () => openPoForm(pr));
}

// ---------- purchase orders ----------
async function renderPos(main) {
  const pos = await api('/pos');
  main.innerHTML = `
    <div class="page-header">
      <div><h2>Purchase Orders</h2><div class="sub">Orders placed with vendors</div></div>
      ${is('procurement') ? '<button class="btn btn-primary" id="btn-new-po">+ New PO</button>' : ''}
    </div>
    <div class="toolbar">
      <select id="po-filter">
        <option value="">All statuses</option>
        ${['open', 'sent', 'partially_received', 'received', 'closed', 'cancelled'].map((s) => `<option value="${s}">${s.replace(/_/g, ' ')}</option>`).join('')}
      </select>
    </div>
    <div class="card table-wrap"><table>
      <thead><tr><th>PO #</th><th>Vendor</th><th>From PR</th><th>Expected</th><th class="num">Total</th><th>Status</th><th>Created by</th></tr></thead>
      <tbody id="po-rows"></tbody>
    </table></div>`;
  const draw = (list) => {
    $('#po-rows').innerHTML = list.length ? list.map((p) => `
      <tr>
        <td><a class="link" href="#/pos/${p.id}">${esc(p.po_number)}</a></td>
        <td class="wrap">${esc(p.vendor_name)}</td>
        <td>${p.pr_number ? esc(p.pr_number) : '—'}</td>
        <td>${fmtDate(p.expected_date)}</td>
        <td class="num">${fmtMoney(p.total)}</td>
        <td>${badge(p.status)}</td>
        <td>${esc(p.created_by_name)}</td>
      </tr>`).join('') : '<tr><td colspan="7" class="empty-state">No purchase orders</td></tr>';
  };
  draw(pos);
  $('#po-filter').addEventListener('change', (e) => draw(e.target.value ? pos.filter((p) => p.status === e.target.value) : pos));
  if (is('procurement')) $('#btn-new-po')?.addEventListener('click', () => openPoForm(null));
}

async function openPoForm(pr) {
  const [vendorsAll, meta] = await Promise.all([api('/vendors'), taxMeta()]);
  const vendors = vendorsAll.filter((v) => v.status === 'active');
  openModal(pr ? `Convert ${pr.pr_number} to PO` : 'New purchase order', `
    <form id="po-form">
      <div class="form-grid">
        <div class="field"><label>Vendor *</label>
          <select name="vendor_id" required>
            <option value="">Select vendor…</option>
            ${vendors.map((v) => `<option value="${v.id}">${esc(v.name)} (${esc(v.code)})${v.vendor_type === 'overseas' ? ' 🌏' : ''}</option>`).join('')}
          </select></div>
        ${!has('tax') ? '' : `
        <div class="field"><label>Buying GST registration *</label>
          <select name="company_gstin_id" required>
            ${meta.gstins.map((g) => `<option value="${g.id}">${esc(g.label)} — ${esc(g.gstin)}</option>`).join('')}
          </select></div>`}
        <div class="field"><label>Expected delivery</label><input name="expected_date" type="date"></div>
        <div class="field full"><label>Notes</label><textarea name="notes"></textarea></div>
      </div>
      ${itemsEditorHtml('Unit price')}
      <div class="form-actions">
        <button type="button" class="btn" onclick="closeModal()">Cancel</button>
        <button type="submit" class="btn btn-primary">Create PO</button>
      </div>
    </form>`);
  if (pr) pr.items.forEach((i) => addItemRow({ description: i.description, quantity: i.quantity, unit: i.unit, price: i.est_unit_price }));
  else addItemRow();
  $('#btn-add-item').addEventListener('click', () => addItemRow());
  $('#po-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target).entries());
    try {
      const r = await api('/pos', {
        method: 'POST',
        body: { pr_id: pr ? pr.id : null, vendor_id: Number(f.vendor_id), company_gstin_id: Number(f.company_gstin_id) || null,
                expected_date: f.expected_date, notes: f.notes, items: readItems('unit_price') },
      });
      toast(`${r.po_number} created`, 'success');
      closeModal();
      location.hash = '#/pos/' + r.id;
    } catch (err) { toast(err.message, 'error'); }
  });
}

async function renderPoDetail(main, id) {
  const po = await api('/pos/' + id);
  const total = po.items.reduce((s, i) => s + i.quantity * i.unit_price, 0);
  const receivable = ['open', 'sent', 'partially_received', 'received'].includes(po.status);
  const outstanding = po.items.some((i) => i.received_qty + i.pending_qty < i.quantity);
  main.innerHTML = `
    <div class="page-header">
      <div><h2>${esc(po.po_number)} ${badge(po.status)}</h2><div class="sub">${esc(po.vendor_name)} · created by ${esc(po.created_by_name)} on ${fmtDate(po.created_at)}</div></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <a class="btn" href="#/pos">← Back</a>
        ${is('procurement') && po.status === 'open' ? `<button class="btn" id="btn-po-sent">Mark sent</button>` : ''}
        ${is('procurement') && receivable && outstanding ? `<button class="btn btn-primary" id="btn-new-grn">+ Record receipt (GRN)</button>` : ''}
        ${!['cancelled'].includes(po.status) ? `<button class="btn btn-primary" id="btn-new-inv">+ Enter invoice</button>` : ''}
        ${is('procurement') && ['open', 'sent'].includes(po.status) ? `<button class="btn btn-danger" id="btn-po-cancel">Cancel PO</button>` : ''}
      </div>
    </div>
    <div class="card card-pad">
      <div class="detail-grid">
        <div class="detail-item"><div class="dl">From PR</div><div class="dv">${po.pr_number ? esc(po.pr_number) : '—'}</div></div>
        <div class="detail-item"><div class="dl">Buying GST registration</div><div class="dv">${po.gstin_label ? `${esc(po.gstin_label)}<br><span style="font-weight:400;font-size:12px;color:var(--text-muted)">${esc(po.company_gstin || '')}</span>` : '—'}</div></div>
        <div class="detail-item"><div class="dl">Expected delivery</div><div class="dv">${fmtDate(po.expected_date)}</div></div>
        <div class="detail-item"><div class="dl">PO total</div><div class="dv">${fmtMoney(total)}</div></div>
        <div class="detail-item"><div class="dl">Notes</div><div class="dv" style="font-weight:400">${esc(po.notes || '—')}</div></div>
      </div>
      <div class="section-title">Line items</div>
      <div class="table-wrap"><table>
        <thead><tr><th>Description</th><th class="num">Ordered</th><th class="num">Accepted</th><th class="num">In review</th><th>Unit</th><th class="num">Unit price</th><th class="num">Amount</th></tr></thead>
        <tbody>${po.items.map((i) => `
          <tr><td class="wrap">${esc(i.description)}</td><td class="num">${i.quantity}</td>
          <td class="num">${i.received_qty}${i.received_qty >= i.quantity ? ' ✅' : ''}</td>
          <td class="num">${i.pending_qty || '—'}</td>
          <td>${esc(i.unit)}</td><td class="num">${fmtMoney(i.unit_price)}</td><td class="num">${fmtMoney(i.quantity * i.unit_price)}</td></tr>`).join('')}
        </tbody>
      </table></div>
      ${po.grns.length ? `<div class="section-title">Goods receipts</div>
        <div class="table-wrap"><table>
          <thead><tr><th>GRN #</th><th>Date</th><th>Received by</th><th>Status</th><th>Notes</th></tr></thead>
          <tbody>${po.grns.map((g) => `<tr><td><a class="link" href="#/grns/${g.id}">${esc(g.grn_number)}</a></td><td>${fmtDate(g.received_date)}</td><td>${esc(g.received_by_name)}</td><td>${badge(g.status)}</td><td class="wrap">${esc(g.notes || '—')}</td></tr>`).join('')}</tbody>
        </table></div>` : ''}
      ${po.invoices.length ? `<div class="section-title">Invoices</div>
        <div class="table-wrap"><table>
          <thead><tr><th>Invoice #</th><th class="num">Total</th><th>Status</th><th>Match</th><th>Source</th></tr></thead>
          <tbody>${po.invoices.map((i) => `<tr><td><a class="link" href="#/invoices/${i.id}">${esc(i.invoice_number)}</a></td><td class="num">${fmtMoney(i.total)}</td><td>${badge(i.status)}</td><td>${badge(i.match_status)}</td><td>${i.source === 'vendor' ? badge('submitted').replace('submitted', 'vendor portal') : badge('draft').replace('draft', 'internal')}</td></tr>`).join('')}</tbody>
        </table></div>` : ''}
    </div>`;

  $('#btn-po-sent')?.addEventListener('click', async () => {
    try { await api(`/pos/${po.id}/status`, { method: 'POST', body: { status: 'sent' } }); toast('PO marked as sent', 'success'); route(); }
    catch (err) { toast(err.message, 'error'); }
  });
  $('#btn-po-cancel')?.addEventListener('click', async () => {
    if (!confirm('Cancel this PO?')) return;
    try { await api(`/pos/${po.id}/status`, { method: 'POST', body: { status: 'cancelled' } }); toast('PO cancelled', 'success'); route(); }
    catch (err) { toast(err.message, 'error'); }
  });
  $('#btn-new-grn')?.addEventListener('click', () => openGrnForm(po));
  $('#btn-new-inv')?.addEventListener('click', () => openInvoiceForm(po));
}

// ---------- GRN ----------
async function renderGrns(main) {
  const grns = await api('/grns');
  main.innerHTML = `
    <div class="page-header">
      <div><h2>Goods Receipts (GRN)</h2><div class="sub">Record deliveries against purchase orders</div></div>
    </div>
    <div class="toolbar">
      <select id="grn-filter">
        <option value="">All statuses</option>
        ${['pending', 'approved', 'rejected'].map((s) => `<option value="${s}">${s}</option>`).join('')}
      </select>
    </div>
    <div class="card table-wrap"><table>
      <thead><tr><th>GRN #</th><th>PO #</th><th>Vendor</th><th>Received</th><th>By</th><th class="num">Lines</th><th>Status</th><th>Reviewed by</th><th>Notes</th></tr></thead>
      <tbody id="grn-rows"></tbody>
    </table></div>`;
  const draw = (list) => {
    $('#grn-rows').innerHTML = list.length ? list.map((g) => `
      <tr>
        <td><a class="link" href="#/grns/${g.id}">${esc(g.grn_number)}</a></td>
        <td><a class="link" href="#/pos/${g.po_id}">${esc(g.po_number)}</a></td>
        <td class="wrap">${esc(g.vendor_name)}</td>
        <td>${fmtDate(g.received_date)}</td>
        <td>${esc(g.received_by_name)}</td>
        <td class="num">${g.line_count}</td>
        <td>${badge(g.status)}</td>
        <td>${esc(g.approved_by_name || '—')}</td>
        <td class="wrap">${esc(g.notes || '—')}</td>
      </tr>`).join('') : '<tr><td colspan="9" class="empty-state">No goods receipts yet. Open a PO to record one.</td></tr>';
  };
  draw(grns);
  $('#grn-filter').addEventListener('change', (e) => draw(e.target.value ? grns.filter((g) => g.status === e.target.value) : grns));
}

async function renderGrnDetail(main, id) {
  const grn = await api('/grns/' + id);
  const canReview = is('approver') && grn.status === 'pending';
  main.innerHTML = `
    <div class="page-header">
      <div><h2>${esc(grn.grn_number)} ${badge(grn.status)}</h2><div class="sub">Against <a class="link" href="#/pos/${grn.po_id}">${esc(grn.po_number)}</a> · ${esc(grn.vendor_name)}</div></div>
      <div style="display:flex;gap:8px">
        <a class="btn" href="#/grns">← Back</a>
        ${canReview ? `<button class="btn btn-danger" id="btn-grn-reject">Reject</button><button class="btn btn-success" id="btn-grn-approve">Approve receipt</button>` : ''}
      </div>
    </div>
    <div class="card card-pad">
      <div class="detail-grid">
        <div class="detail-item"><div class="dl">Received date</div><div class="dv">${fmtDate(grn.received_date)}</div></div>
        <div class="detail-item"><div class="dl">Received by</div><div class="dv">${esc(grn.received_by_name)}</div></div>
        <div class="detail-item"><div class="dl">Reviewed by</div><div class="dv">${esc(grn.approved_by_name || 'Pending review')}</div></div>
        <div class="detail-item"><div class="dl">Notes</div><div class="dv" style="font-weight:400">${esc(grn.notes || '—')}</div></div>
      </div>
      <div class="section-title">Received lines</div>
      <div class="table-wrap"><table>
        <thead><tr><th>Description</th><th class="num">Qty received</th><th>Unit</th><th>Condition notes</th></tr></thead>
        <tbody>${grn.items.map((i) => `
          <tr><td class="wrap">${esc(i.description)}</td><td class="num">${i.quantity_received}</td><td>${esc(i.unit)}</td><td class="wrap">${esc(i.condition_notes || '—')}</td></tr>`).join('')}
        </tbody>
      </table></div>
    </div>`;
  if (canReview) {
    $('#btn-grn-approve').addEventListener('click', async () => {
      try { await api(`/grns/${grn.id}/approve`, { method: 'POST' }); toast('GRN approved — receipt now counts toward the PO', 'success'); route(); }
      catch (err) { toast(err.message, 'error'); }
    });
    $('#btn-grn-reject').addEventListener('click', async () => {
      const reason = prompt('Reason for rejecting this receipt (optional):') ?? '';
      try { await api(`/grns/${grn.id}/reject`, { method: 'POST', body: { reason } }); toast('GRN rejected', 'success'); route(); }
      catch (err) { toast(err.message, 'error'); }
    });
  }
}

function openGrnForm(po) {
  const open = po.items.filter((i) => i.received_qty + i.pending_qty < i.quantity);
  openModal(`Record receipt — ${po.po_number}`, `
    <form id="grn-form">
      <div class="form-grid">
        <div class="field"><label>Received date</label><input name="received_date" type="date" value="${new Date().toISOString().slice(0, 10)}"></div>
        <div class="field full"><label>Notes</label><textarea name="notes" placeholder="Delivery / condition notes"></textarea></div>
      </div>
      <div class="section-title">Quantities received</div>
      <div class="table-wrap"><table>
        <thead><tr><th>Item</th><th class="num">Ordered</th><th class="num">Already received</th><th style="width:120px">Receive now</th></tr></thead>
        <tbody>${open.map((i) => `
          <tr>
            <td class="wrap">${esc(i.description)}</td>
            <td class="num">${i.quantity}</td>
            <td class="num">${i.received_qty + i.pending_qty}${i.pending_qty ? ` (${i.pending_qty} in review)` : ''}</td>
            <td><input type="number" min="0" max="${i.quantity - i.received_qty - i.pending_qty}" step="any" data-po-item="${i.id}"
                 style="width:110px;padding:7px 9px;border:1px solid var(--border);border-radius:8px" placeholder="0"></td>
          </tr>`).join('')}
        </tbody>
      </table></div>
      <div class="form-actions">
        <button type="button" class="btn" onclick="closeModal()">Cancel</button>
        <button type="submit" class="btn btn-primary">Post GRN</button>
      </div>
    </form>`);
  $('#grn-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target).entries());
    const items = [...document.querySelectorAll('[data-po-item]')].map((inp) => ({
      po_item_id: Number(inp.dataset.poItem),
      quantity_received: Number(inp.value) || 0,
    }));
    try {
      const r = await api('/grns', { method: 'POST', body: { po_id: po.id, received_date: f.received_date, notes: f.notes, items } });
      toast(`${r.grn_number} posted`, 'success');
      closeModal(); route();
    } catch (err) { toast(err.message, 'error'); }
  });
}

// ---------- invoices ----------
async function renderInvoices(main) {
  const invoices = await api('/invoices');
  main.innerHTML = `
    <div class="page-header">
      <div><h2>Invoices</h2><div class="sub">Vendor invoices with 3-way match against PO &amp; GRN</div></div>
    </div>
    <div class="toolbar">
      <select id="inv-filter">
        <option value="">All statuses</option>
        ${['pending', 'approved', 'partially_paid', 'paid', 'rejected'].map((s) => `<option value="${s}">${s.replace('_', ' ')}</option>`).join('')}
      </select>
    </div>
    <div class="card table-wrap"><table>
      <thead><tr><th>Invoice #</th><th>Vendor ref</th><th>Vendor</th><th>PO #</th><th>Due</th><th class="num">Total</th><th class="num">Paid</th><th>Source</th><th>Match</th><th>Status</th></tr></thead>
      <tbody id="inv-rows"></tbody>
    </table></div>`;
  const draw = (list) => {
    $('#inv-rows').innerHTML = list.length ? list.map((i) => `
      <tr>
        <td><a class="link" href="#/invoices/${i.id}">${esc(i.invoice_number)}</a>${i.attachment_name ? ' 📎' : ''}</td>
        <td>${esc(i.vendor_invoice_ref || '—')}</td>
        <td class="wrap">${esc(i.vendor_name)}</td>
        <td>${esc(i.po_number)}</td>
        <td>${fmtDate(i.due_date)}</td>
        <td class="num">${fmtMoney(i.total)}</td>
        <td class="num">${fmtMoney(i.paid_amount)}</td>
        <td>${i.source === 'vendor' ? badge('submitted').replace('submitted', 'vendor') : badge('draft').replace('draft', 'internal')}</td>
        <td>${badge(i.match_status)}</td>
        <td>${badge(i.status)}</td>
      </tr>`).join('') : '<tr><td colspan="10" class="empty-state">No invoices. Enter one from a PO page.</td></tr>';
  };
  draw(invoices);
  $('#inv-filter').addEventListener('change', (e) => draw(e.target.value ? invoices.filter((i) => i.status === e.target.value) : invoices));
}

async function renderInvoiceDetail(main, id) {
  const inv = await api('/invoices/' + id);
  const netPayable = inv.total - inv.tds_amount;
  const outstanding = netPayable - inv.paid_amount;
  const canPay = has('payments') && is('finance') && ['approved', 'partially_paid'].includes(inv.status) && outstanding > 0.01;
  main.innerHTML = `
    <div class="page-header">
      <div><h2>${esc(inv.invoice_number)} ${badge(inv.status)} ${badge(inv.match_status)} ${inv.rcm ? badge('rcm').replace('rcm', 'RCM') : ''}</h2>
        <div class="sub">${esc(inv.vendor_name)} · against <a class="link" href="#/pos/${inv.po_id}">${esc(inv.po_number)}</a>
        ${inv.gstin_label ? ` · booked under ${esc(inv.gstin_label)}` : ''}</div></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <a class="btn" href="#/invoices">← Back</a>
        ${inv.my_action ? `<button class="btn btn-danger" id="btn-inv-reject">Reject</button>` : ''}
        ${inv.my_action === 'step' ? `<button class="btn btn-success" id="btn-inv-step">Approve (level check)</button>` : ''}
        ${inv.my_action === 'final' ? `<button class="btn btn-success" id="btn-inv-approve">Review &amp; approve…</button>` : ''}
        ${canPay ? `<button class="btn btn-primary" id="btn-inv-pay">+ Record payment</button>` : ''}
      </div>
    </div>
    <div class="card card-pad">
      <div class="detail-grid">
        <div class="detail-item"><div class="dl">Vendor invoice ref</div><div class="dv">${esc(inv.vendor_invoice_ref || '—')}</div></div>
        <div class="detail-item"><div class="dl">Invoice date</div><div class="dv">${fmtDate(inv.invoice_date)}</div></div>
        <div class="detail-item"><div class="dl">Invoice Receipt Date</div><div class="dv">${fmtDate(inv.received_date)}</div></div>
        <div class="detail-item"><div class="dl">Due date</div><div class="dv">${fmtDate(inv.due_date)}</div></div>
        <div class="detail-item"><div class="dl">Taxable value</div><div class="dv">${fmtMoney(inv.subtotal)}</div></div>
        ${has('tax') ? `
        <div class="detail-item"><div class="dl">Place of Supply</div><div class="dv">${inv.place_of_supply_code ? `${esc(inv.place_of_supply_code)} — ${esc(inv.place_of_supply_state || '')}` : '—'}</div></div>
        <div class="detail-item"><div class="dl">HSN/SAC Code</div><div class="dv">${esc(inv.hsn_sac_code || '—')}</div></div>` : ''}
        ${inv.rcm ? `
          <div class="detail-item"><div class="dl">IGST (RCM self-assessed)</div><div class="dv">${fmtMoney(inv.igst_amount)}</div></div>
          <div class="detail-item"><div class="dl">RCM category</div><div class="dv">${esc(inv.rcm_category_name || '—')}</div></div>` : `
          <div class="detail-item"><div class="dl">CGST</div><div class="dv">${fmtMoney(inv.cgst_amount)}</div></div>
          <div class="detail-item"><div class="dl">SGST</div><div class="dv">${fmtMoney(inv.sgst_amount)}</div></div>
          <div class="detail-item"><div class="dl">IGST</div><div class="dv">${fmtMoney(inv.igst_amount)}</div></div>`}
        <div class="detail-item"><div class="dl">Invoice total${inv.rcm ? ' (payable to vendor)' : ''}</div><div class="dv">${fmtMoney(inv.total)}</div></div>
        <div class="detail-item"><div class="dl">TDS ${inv.tds_section ? `u/s ${esc(inv.tds_section)} @ ${inv.tds_rate}%` : ''}</div>
          <div class="dv">${inv.tds_amount ? '− ' + fmtMoney(inv.tds_amount) : inv.status === 'pending' && has('tax') ? 'Set at approval' : '—'}</div></div>
        <div class="detail-item"><div class="dl">Net payable</div><div class="dv">${fmtMoney(netPayable)}</div></div>
        <div class="detail-item"><div class="dl">Paid</div><div class="dv">${fmtMoney(inv.paid_amount)}</div></div>
        <div class="detail-item"><div class="dl">Outstanding</div><div class="dv" style="color:${outstanding > 0.01 ? 'var(--red)' : 'var(--green)'}">${fmtMoney(outstanding)}</div></div>
        ${!has('tax') ? '' : `
        <div class="detail-item"><div class="dl">ITC</div><div class="dv">${badge(inv.itc_eligibility)}</div></div>
        <div class="detail-item"><div class="dl">GSTR-2B</div><div class="dv">${badge(inv.gstr2b_status)}${inv.gstr2b_notes ? `<div style="font-weight:400;font-size:12px;color:var(--text-muted)">${esc(inv.gstr2b_notes)}</div>` : ''}</div></div>
        ${inv.gl_description ? `<div class="detail-item"><div class="dl">Description</div><div class="dv">${esc(inv.gl_description)}</div></div>` : ''}
        ${inv.sub_location ? `<div class="detail-item"><div class="dl">Sub-location</div><div class="dv">${esc(inv.sub_location)}</div></div>` : ''}
        ${inv.cost_centre ? `<div class="detail-item"><div class="dl">Cost centre</div><div class="dv">${esc(inv.cost_centre)}</div></div>` : ''}
        ${inv.program_product_code ? `<div class="detail-item"><div class="dl">Program/Product code</div><div class="dv">${esc(inv.program_product_code)}</div></div>` : ''}
        ${inv.gl_period ? `<div class="detail-item"><div class="dl">GL period</div><div class="dv">${esc(inv.gl_period)}</div></div>` : ''}`}
        ${inv.booking_je_number ? `<div class="detail-item"><div class="dl">Booking JE</div><div class="dv"><a class="link" href="#/journal">${esc(inv.booking_je_number)}</a></div></div>` : ''}
        ${inv.currency !== 'INR' ? `<div class="detail-item"><div class="dl">Currency</div><div class="dv">${esc(inv.currency)}${inv.foreign_amount ? ` ${inv.foreign_amount} @ ${inv.fx_rate}` : ''}</div></div>` : ''}
      </div>
      <div class="detail-item"><div class="dl">3-way match result</div>
        <div class="dv" style="font-weight:400;color:${inv.match_status === 'mismatch' ? 'var(--red)' : 'var(--text)'}">${esc(inv.match_notes || '—')}</div></div>
      <div class="detail-item" style="margin-top:12px"><div class="dl">Entered by</div>
        <div class="dv">${esc(inv.created_by_name)}${inv.source === 'vendor' ? ' · submitted via vendor portal' : ''}</div></div>
      ${inv.attachment_name ? `<div class="detail-item" style="margin-top:12px"><div class="dl">Attachment</div>
        <div class="dv"><a class="link" href="/api/invoices/${inv.id}/attachment?token=${encodeURIComponent(TOKEN)}" target="_blank">📎 ${esc(inv.attachment_name)}</a></div></div>` : ''}
      ${inv.approved_by_name ? `<div class="detail-item" style="margin-top:12px"><div class="dl">Reviewed by</div><div class="dv">${esc(inv.approved_by_name)}</div></div>` : ''}
      ${chainHtml(inv.approval_chain)}
      ${inv.payments.length ? `<div class="section-title">Payments</div>
        <div class="table-wrap"><table>
          <thead><tr><th>Payment #</th><th>Date</th><th class="num">Amount</th><th>Method</th><th>Reference</th><th>Status</th><th>By</th></tr></thead>
          <tbody>${inv.payments.map((p) => `
            <tr><td>${esc(p.payment_number)}</td><td>${fmtDate(p.payment_date)}</td><td class="num">${fmtMoney(p.amount)}</td>
            <td>${esc(p.method.replace('_', ' '))}</td><td>${esc(p.reference || '—')}</td>
            <td>${badge(p.status === 'pending_release' ? 'pending' : p.status).replace('pending<', 'awaiting release<')}</td>
            <td>${esc(p.created_by_name)}</td></tr>`).join('')}</tbody>
        </table></div>` : ''}
    </div>`;
  $('#btn-inv-approve')?.addEventListener('click', () => openApproveModal(inv));
  $('#btn-inv-step')?.addEventListener('click', async () => {
    const comment = prompt('Comment (optional):') ?? '';
    try {
      const r = await api(`/invoices/${inv.id}/approve`, { method: 'POST', body: { comment } });
      toast(`Level approved — now awaiting ${r.awaiting}`, 'success');
      route();
    } catch (err) { toast(err.message, 'error'); }
  });
  $('#btn-inv-reject')?.addEventListener('click', async () => {
    const reason = prompt('Reason for rejection (optional):') ?? '';
    try { await api(`/invoices/${inv.id}/reject`, { method: 'POST', body: { reason } }); toast('Invoice rejected', 'success'); route(); }
    catch (err) { toast(err.message, 'error'); }
  });
  $('#btn-inv-pay')?.addEventListener('click', () => openPaymentForm(inv));
}

async function openInvoiceForm(po) {
  const meta = await taxMeta();
  const overseas = po.vendor_type === 'overseas';
  openModal(`Enter invoice — ${po.po_number}`, `
    <form id="inv-form">
      <div class="form-grid">
        <div class="field"><label>Vendor invoice ref</label><input name="vendor_invoice_ref" placeholder="Vendor's invoice number"></div>
        ${!has('tax') ? '' : `
        <div class="field"><label>Company GST registration</label>
          <select name="company_gstin_id" id="inv-gstin">
            ${meta.gstins.map((g) => `<option value="${g.id}" ${g.id === po.company_gstin_id ? 'selected' : ''}>${esc(g.label)} — ${esc(g.gstin)}</option>`).join('')}
          </select></div>`}
        <div class="field"><label>Invoice date *</label><input name="invoice_date" id="inv-invoice-date" type="date" required value="${new Date().toISOString().slice(0, 10)}"></div>
        <div class="field"><label>Invoice Receipt Date</label><input name="received_date" id="inv-received-date" type="date"></div>
        <div class="field"><label>Due date <span style="color:var(--text-muted);font-weight:400">(blank = auto from receipt date + payment terms)</span></label><input name="due_date" type="date"></div>
        <div class="field"><label>Taxable value / subtotal (₹) *</label><input name="subtotal" type="number" min="0.01" step="any" required></div>
        ${has('tax') ? `
        <div class="field"><label>Place of Supply${po.vendor_gstin ? ' *' : ''}</label>
          <select name="place_of_supply_code" id="inv-pos" ${po.vendor_gstin ? 'required' : ''}>
            <option value="">— select —</option>
            ${meta.gst_states.map((s) => `<option value="${s.code}" ${s.code === (po.vendor_gstin || '').slice(0, 2) ? 'selected' : ''}>${s.code} — ${esc(s.name)}</option>`).join('')}
          </select></div>
        <div class="field"><label>HSN/SAC Code${po.vendor_gstin ? ' *' : ''}</label><input name="hsn_sac_code" ${po.vendor_gstin ? 'required' : ''} placeholder="e.g. 998314"></div>
        <div class="field full"><label>Description <span style="color:var(--text-muted);font-weight:400">(max 50 chars, for GL export)</span></label>
          <input name="gl_description" maxlength="50"></div>` : ''}
        ${overseas ? `
        <div class="field"><label>Foreign amount (optional)</label><input name="foreign_amount" type="number" min="0" step="any" placeholder="e.g. 2400"></div>
        <div class="field"><label>Exchange rate (optional)</label><input name="fx_rate" type="number" min="0" step="any" placeholder="e.g. 84"></div>` : ''}
      </div>
      ${overseas && has('tax') ? `
        <div class="verify-note" style="background:#ede9fe;color:#5b21b6;border-radius:8px;padding:10px 12px;margin-top:12px;font-size:13px">
          🌏 Overseas vendor — booked under <strong>RCM (Import of services)</strong>. IGST is self-assessed
          (entered at approval) and is <strong>not payable to the vendor</strong>.</div>` : overseas ? '' : `
        <div style="margin-top:14px">
          ${!has('tax') ? '' : `
          <label style="font-weight:600;font-size:12.5px"><input type="checkbox" id="inv-rcm" style="width:auto;margin-right:6px">Reverse charge (RCM) applies</label>
          <div id="rcm-fields" class="form-grid hidden" style="margin-top:10px">
            <div class="field"><label>RCM category</label>
              <select name="rcm_category_id">
                ${meta.rcm_categories.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}
              </select></div>
            <div class="field"><label>Self-assessed IGST (₹)</label><input name="rcm_igst_entry" type="number" min="0" step="any" value="0"></div>
          </div>`}
          <div id="gst-fields" class="form-grid" style="margin-top:10px">
            <div class="field" id="f-cgst"><label>CGST (₹)</label><input name="cgst_amount" type="number" min="0" step="any" value="0"></div>
            <div class="field" id="f-sgst"><label>SGST (₹)</label><input name="sgst_amount" type="number" min="0" step="any" value="0"></div>
            <div class="field" id="f-igst"><label>IGST (₹)</label><input name="igst_amount" type="number" min="0" step="any" value="0"></div>
          </div>
          <div id="supply-hint" style="color:var(--text-muted);font-size:12.5px;margin-top:4px"></div>
        </div>`}
      <div class="field full" style="margin-top:12px"><label>Invoice copy (PDF/PNG/JPG, max 5 MB)</label>
        <input name="attachment" type="file" accept=".pdf,.png,.jpg,.jpeg"></div>
      <div id="inv-chain-preview" style="background:var(--bg);border-radius:8px;padding:9px 12px;margin-top:12px;font-size:12.5px"></div>
      <p style="color:var(--text-muted);font-size:12.5px;margin-top:10px">
        On save, the invoice is 3-way matched against the PO and approved goods receipts, then routed
        through the approval matrix.${has('tax') ? ' TDS section &amp; rate are selected at the final (finance) approval.' : ''}</p>
      <div class="form-actions">
        <button type="button" class="btn" onclick="closeModal()">Cancel</button>
        <button type="submit" class="btn btn-primary">Save invoice</button>
      </div>
    </form>`);

  const vendorState = (po.vendor_gstin || '').slice(0, 2);
  const updateSupplyHint = () => {
    if (overseas) return;
    const g = meta.gstins.find((x) => String(x.id) === $('#inv-gstin').value);
    const intra = vendorState && g && vendorState === g.state_code;
    const hint = $('#supply-hint');
    if (!vendorState) hint.textContent = 'Vendor has no GSTIN on file — enter the applicable GST manually.';
    else hint.textContent = intra
      ? `Intra-state supply (vendor state ${vendorState} = ${g.state_name}) → CGST + SGST`
      : `Inter-state supply (vendor state ${vendorState} ≠ registration state ${g ? g.state_code : '?'}) → IGST`;
    $('#f-cgst').style.opacity = intra || !vendorState ? 1 : 0.45;
    $('#f-sgst').style.opacity = intra || !vendorState ? 1 : 0.45;
    $('#f-igst').style.opacity = !intra || !vendorState ? 1 : 0.45;
  };
  if (!overseas && has('tax')) {
    updateSupplyHint();
    $('#inv-gstin').addEventListener('change', updateSupplyHint);
    $('#inv-rcm').addEventListener('change', (e) => {
      $('#rcm-fields').classList.toggle('hidden', !e.target.checked);
      $('#gst-fields').classList.toggle('hidden', e.target.checked);
    });
  }
  // convenience default: receipt date follows invoice date until the user edits it directly
  $('#inv-invoice-date').addEventListener('change', (e) => {
    if (!$('#inv-received-date').value) $('#inv-received-date').value = e.target.value;
  });

  const invTotal = () => {
    const n = (name) => Number($(`#inv-form [name=${name}]`)?.value) || 0;
    return n('subtotal') + n('cgst_amount') + n('sgst_amount') + n('igst_amount');
  };
  const refreshInvChain = attachChainPreview('#inv-chain-preview', 'invoice',
    () => USER.department_id || '', invTotal);
  $('#inv-form').addEventListener('input', refreshInvChain);

  $('#inv-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target).entries());
    const rcmChecked = has('tax') && (overseas || $('#inv-rcm')?.checked);
    const fd = new FormData();
    const fields = {
      po_id: po.id, ...f,
      rcm: rcmChecked ? 1 : 0,
      igst_amount: rcmChecked ? Number(f.rcm_igst_entry) || 0 : f.igst_amount || 0,
      cgst_amount: rcmChecked ? 0 : f.cgst_amount || 0,
      sgst_amount: rcmChecked ? 0 : f.sgst_amount || 0,
    };
    for (const [k, v] of Object.entries(fields)) {
      if (k === 'attachment') continue;
      fd.append(k, v ?? '');
    }
    const file = e.target.querySelector('[name=attachment]')?.files[0];
    if (file) fd.append('attachment', file);
    try {
      const r = await api('/invoices', { method: 'POST', body: fd });
      toast(`${r.invoice_number} saved — match: ${r.match_status}`, r.match_status === 'mismatch' ? 'error' : 'success');
      closeModal();
      location.hash = '#/invoices/' + r.id;
    } catch (err) { toast(err.message, 'error'); }
  });
}

// ---------- invoice approval (TDS + ITC + RCM, posts the booking JE) ----------
async function openApproveModal(inv) {
  // without the tax module there is no TDS/JE step — final approval is a plain confirm
  if (!has('tax')) {
    openModal(`Approve ${inv.invoice_number}`, `
      ${inv.match_status === 'mismatch' ? `<div class="form-error">⚠️ 3-way match mismatch: ${esc(inv.match_notes || '')}<br>Approving overrides the mismatch.</div>` : ''}
      <form id="approve-form">
        <div class="card card-pad" style="background:var(--bg)">
          <div style="display:flex;justify-content:space-between;font-size:13.5px"><span>Invoice total</span><strong>${fmtMoney(inv.total)}</strong></div>
        </div>
        <p style="color:var(--text-muted);font-size:12.5px;margin-top:10px">
          This is the final approval level — the invoice becomes payable in full.</p>
        <div class="form-actions">
          <button type="button" class="btn" onclick="closeModal()">Cancel</button>
          <button type="submit" class="btn btn-success">Approve invoice</button>
        </div>
      </form>`);
    $('#approve-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const r = await api(`/invoices/${inv.id}/approve`, { method: 'POST', body: {} });
        toast(`Approved — net payable ${fmtMoney(r.netPayable)}`, 'success');
        closeModal(); route();
      } catch (err) { toast(err.message, 'error'); }
    });
    return;
  }
  const [meta, certs] = await Promise.all([taxMeta(), api(`/vendors/${inv.vendor_id}/tds-certificates`)]);
  const sections = meta.tds_sections;
  const labels = meta.custom_field_labels;
  // a certificate valid for the chosen section on this invoice's date suggests its rate —
  // but only while this invoice still fits within whatever threshold it has left
  const certFor = (section) => certs.find((c) => c.active && c.tds_section === section
    && c.valid_from <= inv.invoice_date && c.valid_to >= inv.invoice_date
    && (c.threshold_amount == null || c.utilized_amount + inv.subtotal <= c.threshold_amount));
  openModal(`Approve ${inv.invoice_number} — booking details`, `
    ${inv.match_status === 'mismatch' ? `<div class="form-error">⚠️ 3-way match mismatch: ${esc(inv.match_notes || '')}<br>Approving overrides the mismatch.</div>` : ''}
    <form id="approve-form">
      <div class="form-grid">
        <div class="field"><label>TDS / WHT section</label>
          <select name="tds_section_pick" id="ap-section">
            <option value="">None — no deduction</option>
            ${sections.map((s, i) => `<option value="${i}" ${inv.vendor_type === 'overseas' && s.section === '195' ? 'selected' : ''}>${esc(s.section)} — ${esc(s.description)} (${s.rate}%)</option>`).join('')}
          </select></div>
        <div class="field"><label>TDS rate (%)</label><input name="tds_rate" id="ap-rate" type="number" min="0" max="40" step="any" value="0"></div>
        <div class="field"><label>TDS base (taxable value)</label><input value="${fmtMoney(inv.subtotal)}" disabled></div>
        <div class="field"><label>ITC eligibility</label>
          <select name="itc_eligibility">
            <option value="eligible">Eligible — take input credit</option>
            <option value="ineligible">Ineligible / blocked u/s 17(5) — expense it</option>
          </select></div>
        ${inv.rcm ? `<div class="field"><label>Self-assessed IGST under RCM (₹)</label>
          <input name="rcm_igst" id="ap-rcm-igst" type="number" min="0" step="any" value="${inv.igst_amount}"></div>` : ''}
        <div class="field full"><label>TDS rate override reason <span style="color:var(--text-muted);font-weight:400">(required only if the rate differs from the section master)</span></label>
          <input name="tds_rate_override_reason" placeholder="e.g. AO order dated …"></div>
      </div>
      <div id="ap-cert-note" style="display:none;background:#ecfdf5;color:#065f46;border-radius:8px;padding:8px 12px;margin-top:10px;font-size:12.5px"></div>
      <div class="section-title">GL classification</div>
      <div class="form-grid">
        <div class="field"><label>Sub-location</label>
          <select name="sub_location">
            <option value="">— none —</option>
            ${meta.sub_locations.map((s) => `<option value="${esc(s.code)}" ${(inv.sub_location || inv.department_default_sub_location) === s.code ? 'selected' : ''}>${esc(s.code)} — ${esc(s.name)}</option>`).join('')}
          </select></div>
        <div class="field"><label>Cost centre</label>
          <select name="cost_centre">
            <option value="">— none —</option>
            ${meta.cost_centres.map((c) => `<option value="${esc(c.code)}" ${(inv.cost_centre || inv.department_default_cost_centre) === c.code ? 'selected' : ''}>${esc(c.code)} — ${esc(c.name)}</option>`).join('')}
          </select></div>
        <div class="field"><label>Program/Product code</label><input name="program_product_code" value="${esc(inv.program_product_code || '')}"></div>
        <div class="field"><label>GL period</label><input name="gl_period" value="${esc(inv.gl_period || inv.invoice_date.slice(0, 7))}" placeholder="YYYY-MM"></div>
        ${[1, 2, 3, 4, 5].map((i) => `
        <div class="field"><label>${esc(labels[`custom_field_${i}`])}</label><input name="custom_field_${i}" value="${esc(inv[`custom_field_${i}`] || '')}"></div>`).join('')}
      </div>
      <div class="card card-pad" style="margin-top:14px;background:var(--bg)">
        <div style="display:flex;justify-content:space-between;font-size:13.5px"><span>Invoice total${inv.rcm ? ' (payable to vendor)' : ''}</span><strong>${fmtMoney(inv.total)}</strong></div>
        <div style="display:flex;justify-content:space-between;font-size:13.5px;color:var(--red)"><span>TDS deduction</span><strong id="ap-tds-amt">− ₹0.00</strong></div>
        <div style="display:flex;justify-content:space-between;font-size:14px;border-top:1px solid var(--border);margin-top:6px;padding-top:6px"><span>Net payable to vendor</span><strong id="ap-net">${fmtMoney(inv.total)}</strong></div>
      </div>
      <p style="color:var(--text-muted);font-size:12.5px;margin-top:10px">
        On approval the booking journal is posted: expense + GST input, AP credited gross, and the TDS
        deduction shown as a separate AP line (visible on the vendor statement).</p>
      <div class="form-actions">
        <button type="button" class="btn" onclick="closeModal()">Cancel</button>
        <button type="submit" class="btn btn-success">Approve &amp; post JE</button>
      </div>
    </form>`);

  let suggestedCertId = null;
  const recalc = () => {
    const rate = Number($('#ap-rate').value) || 0;
    const tds = Math.round(inv.subtotal * rate) / 100;
    $('#ap-tds-amt').textContent = '− ' + fmtMoney(tds);
    $('#ap-net').textContent = fmtMoney(inv.total - tds);
  };
  $('#ap-section').addEventListener('change', (e) => {
    const s = sections[Number(e.target.value)];
    const cert = s ? certFor(s.section) : null;
    suggestedCertId = cert ? cert.id : null;
    $('#ap-rate').value = cert ? cert.rate : (s ? s.rate : 0);
    const note = $('#ap-cert-note');
    if (cert) {
      note.style.display = 'block';
      note.textContent = `Using lower-TDS certificate ${cert.certificate_number} (${cert.rate}%, valid ${fmtDate(cert.valid_from)}–${fmtDate(cert.valid_to)}` +
        (cert.threshold_amount != null ? `, ${fmtMoney(cert.threshold_amount - cert.utilized_amount - inv.subtotal)} of its ${fmtMoney(cert.threshold_amount)} threshold left after this invoice` : '') +
        `) instead of the standard rate.`;
    } else {
      note.style.display = 'none';
    }
    recalc();
  });
  $('#ap-rate').addEventListener('input', () => { suggestedCertId = null; recalc(); });
  // pre-select 195 default rate for overseas vendors
  if (inv.vendor_type === 'overseas') { $('#ap-section').dispatchEvent(new Event('change')); }

  $('#approve-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target).entries());
    const s = f.tds_section_pick === '' ? null : sections[Number(f.tds_section_pick)];
    try {
      const r = await api(`/invoices/${inv.id}/approve`, {
        method: 'POST',
        body: {
          tds_section: s ? s.section : 'none',
          tds_rate: Number(f.tds_rate) || 0,
          tds_certificate_id: suggestedCertId || undefined,
          itc_eligibility: f.itc_eligibility,
          rcm_igst: f.rcm_igst,
          sub_location: f.sub_location, cost_centre: f.cost_centre,
          program_product_code: f.program_product_code, gl_period: f.gl_period,
          custom_field_1: f.custom_field_1, custom_field_2: f.custom_field_2, custom_field_3: f.custom_field_3,
          custom_field_4: f.custom_field_4, custom_field_5: f.custom_field_5,
        },
      });
      toast(`Approved — ${r.jeNumber} posted, net payable ${fmtMoney(r.netPayable)}`, 'success');
      closeModal(); route();
    } catch (err) { toast(err.message, 'error'); }
  });
}

// ---------- payments (maker-checker) ----------
async function renderPayments(main) {
  const payments = await api('/payments');
  const pending = payments.filter((p) => p.status === 'pending_release');
  main.innerHTML = `
    <div class="page-header">
      <div><h2>Payments</h2><div class="sub">Maker-checker: prepared by one finance user, released by another</div></div>
      ${pending.length && is('finance') ? `<a class="btn" href="/api/payments/export-bank?token=${encodeURIComponent(TOKEN)}">⬇ Bank file (${pending.length} pending)</a>` : ''}
    </div>
    <div class="card table-wrap"><table>
      <thead><tr><th>Payment #</th><th>Invoice</th><th>Vendor</th><th>Date</th><th class="num">Amount</th><th>Method</th><th>Reference</th><th>Status</th><th>Maker</th><th>Checker</th><th></th></tr></thead>
      <tbody>${payments.length ? payments.map((p) => `
        <tr>
          <td>${esc(p.payment_number)}</td>
          <td><a class="link" href="#/invoices/${p.invoice_id}">${esc(p.invoice_number)}</a></td>
          <td class="wrap">${esc(p.vendor_name)}</td>
          <td>${fmtDate(p.payment_date)}</td>
          <td class="num">${fmtMoney(p.amount)}</td>
          <td>${esc(p.method.replace('_', ' '))}</td>
          <td>${esc(p.reference || '—')}</td>
          <td>${badge(p.status === 'pending_release' ? 'pending' : p.status).replace('pending<', 'awaiting release<')}</td>
          <td>${esc(p.created_by_name)}</td>
          <td>${esc(p.released_by_name || '—')}</td>
          <td style="white-space:nowrap">${p.status === 'pending_release' && is('finance') ? `
            ${p.created_by !== USER.id || USER.role === 'admin' ? `<button class="btn btn-sm btn-success" data-release="${p.id}">Release</button>` : ''}
            <button class="btn btn-sm btn-danger" data-cancel="${p.id}">Cancel</button>` : ''}</td>
        </tr>`).join('') : '<tr><td colspan="11" class="empty-state">No payments. Open an approved invoice to prepare one.</td></tr>'}
      </tbody>
    </table></div>
    <p style="color:var(--text-muted);font-size:12.5px;margin-top:10px">
      Prepared payments have no accounting effect until released. The bank file contains all payments awaiting
      release with beneficiary account details, ready for your bank's bulk-upload. After the bank run, release
      each payment (optionally recording the UTR) — that posts the journal entry and notifies the vendor.</p>`;

  main.querySelectorAll('[data-release]').forEach((b) => b.addEventListener('click', async () => {
    const reference = prompt('Bank reference / UTR (optional):') ?? '';
    try {
      const r = await api(`/payments/${b.dataset.release}/release`, { method: 'POST', body: { reference } });
      toast(`Payment released — ${r.jeNumber} posted`, 'success');
      route();
    } catch (err) { toast(err.message, 'error'); }
  }));
  main.querySelectorAll('[data-cancel]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Cancel this prepared payment?')) return;
    try {
      await api(`/payments/${b.dataset.cancel}/cancel`, { method: 'POST' });
      toast('Payment cancelled', 'success');
      route();
    } catch (err) { toast(err.message, 'error'); }
  }));
}

function openPaymentForm(inv) {
  const outstanding = inv.total - inv.tds_amount - inv.paid_amount;
  openModal(`Record payment — ${inv.invoice_number}`, `
    <form id="pay-form">
      <div class="form-grid">
        <div class="field"><label>Amount (₹) * <span style="color:var(--text-muted);font-weight:400">(outstanding ${fmtMoney(outstanding)}, net of TDS)</span></label>
          <input name="amount" type="number" min="0.01" max="${outstanding}" step="any" required value="${outstanding.toFixed(2)}"></div>
        <div class="field"><label>Payment date</label><input name="payment_date" type="date" value="${new Date().toISOString().slice(0, 10)}"></div>
        <div class="field"><label>Method</label>
          <select name="method">
            ${['bank_transfer', 'upi', 'cheque', 'card', 'cash'].map((m) => `<option value="${m}">${m.replace('_', ' ')}</option>`).join('')}
          </select></div>
        <div class="field"><label>Reference (UTR / cheque no.)</label><input name="reference"></div>
        <div class="field full"><label>Notes</label><textarea name="notes"></textarea></div>
      </div>
      <div class="form-actions">
        <button type="button" class="btn" onclick="closeModal()">Cancel</button>
        <button type="submit" class="btn btn-primary">Record payment</button>
      </div>
    </form>`);
  $('#pay-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target).entries());
    try {
      const r = await api('/payments', { method: 'POST', body: { invoice_id: inv.id, ...f } });
      toast(`${r.payment_number} prepared — another finance user must release it (Payments page)`, 'success');
      closeModal(); route();
    } catch (err) { toast(err.message, 'error'); }
  });
}

// ---------- my approvals (inbox) ----------
async function renderMyApprovals(main) {
  const d = await api('/my-approvals');

  // one aligned row: [identifier + description] ...... [amount | meta | button]
  const row = ({ href, number, title, amount, meta }) => `
    <div class="inbox-row">
      <div class="inbox-main">
        ${href ? `<a class="link" href="${href}">${esc(number)}</a>` : `<strong>${esc(number)}</strong>`}
        <div class="inbox-title">${esc(title)}</div>
      </div>
      <div class="inbox-amount">${amount !== undefined ? fmtMoney(amount) : ''}</div>
      <div class="inbox-meta">${meta || ''}</div>
      <a class="btn btn-sm btn-primary" href="${href || '#/my-approvals'}">Review →</a>
    </div>`;

  const section = (title, rows, renderRow) => rows.length ? `
    <h4 style="margin:18px 0 8px">${title} (${rows.length})</h4>
    <div class="card">${rows.map(renderRow).join('')}</div>` : '';

  main.innerHTML = `
    <style>
      .inbox-row { display:flex; align-items:center; gap:16px; padding:12px 18px; border-bottom:1px solid var(--border); }
      .inbox-row:last-child { border-bottom:none; }
      .inbox-main { flex:1; min-width:0; }
      .inbox-title { color:var(--text-muted); font-size:12.5px; margin-top:2px;
                     overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .inbox-amount { width:130px; text-align:right; font-weight:700; font-variant-numeric:tabular-nums; flex-shrink:0; }
      .inbox-meta { width:170px; text-align:right; font-size:12.5px; color:var(--text-muted); flex-shrink:0;
                    display:flex; justify-content:flex-end; gap:5px; flex-wrap:wrap; }
      @media (max-width: 700px) {
        .inbox-row { flex-wrap:wrap; }
        .inbox-amount, .inbox-meta { width:auto; }
      }
    </style>
    <div class="page-header">
      <div><h2>My Approvals</h2><div class="sub">Everything currently waiting for you${d.total ? ` — ${d.total} item${d.total > 1 ? 's' : ''}` : ''}</div></div>
    </div>
    ${d.total === 0 ? '<div class="card empty-state">🎉 Nothing is waiting for you right now</div>' : ''}
    ${section('Purchase requisitions', d.prs, (r) =>
      row({ href: `#/prs/${r.id}`, number: r.number, title: r.title, amount: r.amount, meta: fmtDate(r.since) }))}
    ${section('Invoices', d.invoices, (r) =>
      row({ href: `#/invoices/${r.id}`, number: r.number, title: r.title, amount: r.amount,
            meta: `${badge(r.match)} ${r.final ? badge('approved').replace('approved', 'final + TDS') : badge('submitted').replace('submitted', 'level check')}` }))}
    ${section('Goods receipts', d.grns, (r) =>
      row({ href: `#/grns/${r.id}`, number: r.number, title: r.title, meta: fmtDate(r.since) }))}
    ${section('Vendors to verify', d.vendors, (r) =>
      row({ href: '#/vendors', number: r.number, title: r.title, meta: fmtDate(r.since) }))}
    ${section('Payments awaiting release', d.payments, (r) =>
      row({ href: '#/payments', number: r.number, title: r.title, amount: r.amount, meta: fmtDate(r.since) }))}`;
}

// ---------- journal entries ----------
async function renderJournal(main) {
  const canExport = is('finance');
  const qs = (f) => {
    const p = new URLSearchParams();
    if (f.type) p.set('type', f.type);
    if (f.from) p.set('from', f.from);
    if (f.to) p.set('to', f.to);
    if (f.export_status) p.set('export_status', f.export_status);
    return p.toString();
  };
  const draw = async (f = {}) => {
    const entries = await api('/journal' + (qs(f) ? '?' + qs(f) : ''));
    $('#je-list').innerHTML = entries.length ? entries.map((je) => `
      <div class="card" style="margin-bottom:12px">
        <div style="display:flex;justify-content:space-between;align-items:center;padding:12px 16px;border-bottom:1px solid var(--border);flex-wrap:wrap;gap:6px">
          <div><strong>${esc(je.je_number)}</strong> · ${fmtDate(je.je_date)} · ${badge(je.type)}
            ${je.export_batch_number ? `<span class="badge badge-gray" title="Exported to ERP in this batch">📤 ${esc(je.export_batch_number)}</span>` : ''}
            <span style="color:var(--text-muted);font-size:12.5px;margin-left:6px">${esc(je.narration || '')}</span></div>
          <span style="color:var(--text-muted);font-size:12px">${esc(je.created_by_name || 'System')}</span>
        </div>
        <div class="table-wrap"><table>
          <thead><tr><th>Account</th><th>Vendor / dimension</th><th class="num">Debit</th><th class="num">Credit</th></tr></thead>
          <tbody>${je.lines.map((l) => `
            <tr>
              <td>${esc(l.account_code)} · ${esc(l.account_name)}</td>
              <td>${esc([l.vendor_name, l.gstin_label].filter(Boolean).join(' · ') || '—')}</td>
              <td class="num">${l.debit ? fmtMoney(l.debit) : ''}</td>
              <td class="num">${l.credit ? fmtMoney(l.credit) : ''}</td>
            </tr>`).join('')}
          </tbody>
        </table></div>
      </div>`).join('') : '<div class="card empty-state">No journal entries here</div>';
  };
  main.innerHTML = `
    <div class="page-header">
      <div><h2>Journal Entries</h2><div class="sub">Auto-posted from invoice bookings, payments and tax deposits</div></div>
      <div style="display:flex;gap:8px">
        ${canExport ? `<button class="btn btn-sm" id="je-history">📋 Export history</button>
        <button class="btn btn-primary btn-sm" id="je-export-batch">📤 Export to ERP</button>` : ''}
      </div>
    </div>
    <p style="color:var(--text-muted);font-size:12.5px;margin-bottom:12px">
      Exporting stamps entries into a batch so they can't be posted to your accounting system twice.
      Already-exported entries move to <strong>Export history</strong>, where a batch can be re-downloaded if a file was lost.</p>
    <div class="toolbar">
      <select id="je-status">
        <option value="ready">Ready to export</option>
        <option value="exported">Exported</option>
        <option value="">All</option>
      </select>
      <select id="je-type">
        <option value="">All types</option>
        ${['invoice_booking', 'payment', 'tds_deposit', 'rcm_deposit'].map((t) => `<option value="${t}">${t.replace(/_/g, ' ')}</option>`).join('')}
      </select>
      <input type="date" id="je-from"> <span style="color:var(--text-muted)">to</span> <input type="date" id="je-to">
      <button class="btn btn-sm" id="je-apply">Apply</button>
    </div>
    <div id="je-list"></div>`;
  const readFilters = () => ({ export_status: $('#je-status').value, type: $('#je-type').value, from: $('#je-from').value, to: $('#je-to').value });
  $('#je-apply').addEventListener('click', () => draw(readFilters()));
  $('#je-status').addEventListener('change', () => draw(readFilters()));
  if (canExport) {
    $('#je-export-batch').addEventListener('click', openExportBatchModal);
    $('#je-history').addEventListener('click', openExportHistoryModal);
  }
  await draw({ export_status: 'ready' });
}

// download an attachment-response URL without navigating the SPA away
function triggerDownload(url) {
  const a = document.createElement('a');
  a.href = url;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function openExportBatchModal() {
  openModal('Export journals to ERP', `
    <p style="color:var(--text-muted);font-size:12.5px;margin-bottom:14px">
      Creates a batch of every entry not yet exported (optionally only those on/before a cut-off date,
      e.g. month-end). Those entries then move to Export history and won't be exported again.</p>
    <form id="export-batch-form">
      <div class="form-grid">
        <div class="field"><label>Include entries through <span style="color:var(--text-muted);font-weight:400">(optional cut-off)</span></label>
          <input name="through_date" type="date"></div>
        <div class="field"><label>Format</label>
          <select name="format"><option value="csv">CSV</option><option value="xlsx">Excel</option></select></div>
      </div>
      <div class="form-actions">
        <button type="button" class="btn" onclick="closeModal()">Cancel</button>
        <button type="submit" class="btn btn-primary">Create batch &amp; download</button>
      </div>
    </form>`);
  $('#export-batch-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target).entries());
    try {
      const batch = await api('/journal/export-batch', { method: 'POST', body: { through_date: f.through_date || '' } });
      triggerDownload(`/api/journal/batches/${batch.id}/download?format=${f.format}&token=${encodeURIComponent(TOKEN)}`);
      toast(`Batch ${batch.batch_number} created — ${batch.je_count} entries exported`, 'success');
      closeModal();
      route();
    } catch (err) { toast(err.message, 'error'); }
  });
}

async function openExportHistoryModal() {
  const batches = await api('/journal/batches');
  openModal('Journal export history', `
    <p style="color:var(--text-muted);font-size:12.5px;margin-bottom:14px">
      Each batch is a permanent record of journals handed to your accounting system.
      Re-download only if the original file was lost — re-importing posts duplicates.</p>
    <div class="table-wrap"><table>
      <thead><tr><th>Batch</th><th>When</th><th>By</th><th class="num">Entries</th><th class="num">Debit</th><th class="num">Credit</th><th>Through</th><th></th></tr></thead>
      <tbody>${batches.length ? batches.map((b) => `
        <tr>
          <td><strong>${esc(b.batch_number)}</strong></td>
          <td>${fmtDate(b.created_at)}</td>
          <td>${esc(b.created_by_name || '—')}</td>
          <td class="num">${b.je_count}</td>
          <td class="num">${fmtMoney(b.total_debit)}</td>
          <td class="num">${fmtMoney(b.total_credit)}</td>
          <td>${b.through_date ? fmtDate(b.through_date) : 'all'}</td>
          <td style="white-space:nowrap">
            <a class="link" href="/api/journal/batches/${b.id}/download?format=csv&token=${encodeURIComponent(TOKEN)}">CSV</a> ·
            <a class="link" href="/api/journal/batches/${b.id}/download?format=xlsx&token=${encodeURIComponent(TOKEN)}">Excel</a>
          </td>
        </tr>`).join('') : '<tr><td colspan="8" class="empty-state">No exports yet</td></tr>'}
      </tbody>
    </table></div>
    <div class="form-actions"><button type="button" class="btn" onclick="closeModal()">Close</button></div>`);
}

// ---------- TDS & RCM deposits ----------
async function renderTax(main) {
  const data = await api('/tax/summary');
  const rows = data.tds.map((r) => ({ ...r, kind: 'tds', outstanding: r.accrued - r.deposited }))
    .concat(data.rcm.map((r) => ({ ...r, kind: 'rcm', section: 'RCM (GST)', outstanding: r.accrued - r.deposited })));
  main.innerHTML = `
    <div class="page-header">
      <div><h2>TDS &amp; RCM Deposits</h2><div class="sub">Liability accrued at booking vs challans deposited</div></div>
      <button class="btn btn-primary" id="btn-new-dep">+ Record challan / deposit</button>
    </div>
    <div class="card table-wrap" style="margin-bottom:16px"><table>
      <thead><tr><th>Period</th><th>Section</th><th class="num">Accrued</th><th class="num">Deposited</th><th class="num">Outstanding</th></tr></thead>
      <tbody>${rows.length ? rows.map((r) => `
        <tr>
          <td>${esc(r.period)}</td>
          <td>${esc(r.section || '—')}</td>
          <td class="num">${fmtMoney(r.accrued)}</td>
          <td class="num">${fmtMoney(r.deposited)}</td>
          <td class="num" style="color:${r.outstanding > 0.01 ? 'var(--red)' : 'var(--green)'}">${fmtMoney(r.outstanding)}</td>
        </tr>`).join('') : '<tr><td colspan="5" class="empty-state">No TDS/RCM liability yet</td></tr>'}
      </tbody>
    </table></div>
    <h4 style="margin:18px 0 10px">Challans recorded</h4>
    <div class="card table-wrap"><table>
      <thead><tr><th>Deposit #</th><th>Kind</th><th>Period</th><th>Section</th><th class="num">Amount</th><th>Challan</th><th>BSR</th><th>Date</th><th>JE</th></tr></thead>
      <tbody>${data.deposits.length ? data.deposits.map((d) => `
        <tr>
          <td>${esc(d.deposit_number)}</td>
          <td>${d.kind.toUpperCase()}</td>
          <td>${esc(d.period)}</td>
          <td>${esc(d.section || '—')}</td>
          <td class="num">${fmtMoney(d.amount)}</td>
          <td>${esc(d.challan_no || '—')}</td>
          <td>${esc(d.bsr_code || '—')}</td>
          <td>${fmtDate(d.deposit_date)}</td>
          <td>${esc(d.je_number || '—')}</td>
        </tr>`).join('') : '<tr><td colspan="9" class="empty-state">No deposits recorded</td></tr>'}
      </tbody>
    </table></div>`;
  $('#btn-new-dep').addEventListener('click', async () => {
    const meta = await taxMeta();
    const uniqueSections = [...new Set(meta.tds_sections.map((s) => s.section))];
    openModal('Record tax deposit (challan)', `
      <form id="dep-form">
        <div class="form-grid">
          <div class="field"><label>Kind</label>
            <select name="kind" id="dep-kind">
              <option value="tds">TDS</option>
              <option value="rcm">RCM GST (cash)</option>
            </select></div>
          <div class="field" id="dep-section-field"><label>Section</label>
            <select name="section">${uniqueSections.map((s) => `<option>${esc(s)}</option>`).join('')}</select></div>
          <div class="field"><label>Period (month) *</label><input name="period" type="month" required></div>
          <div class="field"><label>Amount (₹) *</label><input name="amount" type="number" min="0.01" step="any" required></div>
          <div class="field"><label>Challan no.</label><input name="challan_no"></div>
          <div class="field"><label>BSR code</label><input name="bsr_code"></div>
          <div class="field"><label>Deposit date *</label><input name="deposit_date" type="date" required value="${new Date().toISOString().slice(0, 10)}"></div>
          <div class="field full"><label>Notes</label><input name="notes"></div>
        </div>
        <div class="form-actions">
          <button type="button" class="btn" onclick="closeModal()">Cancel</button>
          <button type="submit" class="btn btn-primary">Save &amp; post JE</button>
        </div>
      </form>`);
    $('#dep-kind').addEventListener('change', (e) => {
      $('#dep-section-field').style.display = e.target.value === 'rcm' ? 'none' : '';
    });
    $('#dep-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const r = await api('/tax/deposits', { method: 'POST', body: Object.fromEntries(new FormData(e.target).entries()) });
        toast(`${r.deposit_number} recorded and journalled`, 'success');
        closeModal(); route();
      } catch (err) { toast(err.message, 'error'); }
    });
  });
}

// ---------- GSTR-2B reconciliation ----------
async function renderGstRecon(main) {
  const meta = await taxMeta();
  main.innerHTML = `
    <div class="page-header">
      <div><h2>GST Input Reconciliation — GSTR-2B</h2>
        <div class="sub">Match booked input credit against the GSTR-2B download, per registration per period</div></div>
    </div>
    <div class="card card-pad" style="margin-bottom:16px">
      <form id="recon-form" style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end">
        <div class="field"><label>Registration</label>
          <select id="recon-gstin">${meta.gstins.map((g) => `<option value="${g.id}">${esc(g.label)} — ${esc(g.gstin)}</option>`).join('')}</select></div>
        <div class="field"><label>Period</label><input type="month" id="recon-period" value="${new Date().toISOString().slice(0, 7)}"></div>
        <div class="field"><label>GSTR-2B CSV</label><input type="file" id="recon-file" accept=".csv"></div>
        <button type="submit" class="btn btn-primary">Import &amp; reconcile</button>
        <button type="button" class="btn" id="recon-view">View results only</button>
      </form>
      <p style="color:var(--text-muted);font-size:12px;margin-top:10px">
        CSV headers: <code>supplier_gstin,invoice_no,invoice_date,taxable_value,cgst,sgst,igst</code>
        (optionally <code>supplier_name</code>). Export these columns from the GSTR-2B Excel on the GST portal.</p>
    </div>
    <div id="recon-results"></div>`;

  const drawResults = async () => {
    const gstinId = $('#recon-gstin').value;
    const period = $('#recon-period').value;
    if (!period) return;
    const d = await api(`/gst/recon?company_gstin_id=${gstinId}&period=${period}`);
    $('#recon-results').innerHTML = `
      <h4 style="margin:6px 0 10px">Booked invoices with input credit — ${esc(period)}</h4>
      <div class="card table-wrap" style="margin-bottom:16px"><table>
        <thead><tr><th>Invoice</th><th>Vendor ref</th><th>Vendor</th><th>GSTIN</th><th class="num">Taxable</th><th class="num">CGST</th><th class="num">SGST</th><th class="num">IGST</th><th>2B status</th></tr></thead>
        <tbody>${d.invoices.length ? d.invoices.map((i) => `
          <tr>
            <td><a class="link" href="#/invoices/${i.id}">${esc(i.invoice_number)}</a></td>
            <td>${esc(i.vendor_invoice_ref || '—')}</td>
            <td class="wrap">${esc(i.vendor_name)}</td>
            <td>${esc(i.vendor_gstin || '—')}</td>
            <td class="num">${fmtMoney(i.subtotal)}</td>
            <td class="num">${fmtMoney(i.cgst_amount)}</td>
            <td class="num">${fmtMoney(i.sgst_amount)}</td>
            <td class="num">${fmtMoney(i.igst_amount)}</td>
            <td>${badge(i.gstr2b_status)}${i.gstr2b_notes ? `<div style="font-size:11px;color:var(--text-muted)">${esc(i.gstr2b_notes)}</div>` : ''}</td>
          </tr>`).join('') : '<tr><td colspan="9" class="empty-state">No booked invoices for this registration &amp; period</td></tr>'}
        </tbody>
      </table></div>
      <h4 style="margin:6px 0 10px">In GSTR-2B but not in books</h4>
      <div class="card table-wrap"><table>
        <thead><tr><th>Supplier GSTIN</th><th>Supplier</th><th>Invoice no.</th><th>Date</th><th class="num">Taxable</th><th class="num">CGST</th><th class="num">SGST</th><th class="num">IGST</th></tr></thead>
        <tbody>${d.unmatched2b.length ? d.unmatched2b.map((l) => `
          <tr>
            <td>${esc(l.supplier_gstin)}</td>
            <td class="wrap">${esc(l.supplier_name || '—')}</td>
            <td>${esc(l.invoice_no)}</td>
            <td>${esc(l.invoice_date || '—')}</td>
            <td class="num">${fmtMoney(l.taxable_value)}</td>
            <td class="num">${fmtMoney(l.cgst)}</td>
            <td class="num">${fmtMoney(l.sgst)}</td>
            <td class="num">${fmtMoney(l.igst)}</td>
          </tr>`).join('') : '<tr><td colspan="8" class="empty-state">None — everything in 2B is booked</td></tr>'}
        </tbody>
      </table></div>`;
  };

  $('#recon-view').addEventListener('click', drawResults);
  $('#recon-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const file = $('#recon-file').files[0];
    if (!file) return toast('Choose the GSTR-2B CSV file first', 'error');
    const fd = new FormData();
    fd.append('file', file);
    fd.append('company_gstin_id', $('#recon-gstin').value);
    fd.append('period', $('#recon-period').value);
    try {
      const r = await api('/gst/gstr2b/import', { method: 'POST', body: fd, headers: {} });
      toast(`Imported ${r.imported} lines: ${r.matched} matched, ${r.mismatched} mismatched, ${r.not_in_books} not in books, ${r.not_in_2b} missing from 2B`, 'success');
      await drawResults();
    } catch (err) { toast(err.message, 'error'); }
  });
}

// ---------- vendor statements ----------
async function renderStatements(main) {
  const vendors = await api('/vendors');
  main.innerHTML = `
    <div class="page-header">
      <div><h2>Vendor Statements</h2><div class="sub">AP ledger per vendor — invoices, TDS deductions and payments</div></div>
    </div>
    <div class="toolbar">
      <select id="stmt-vendor">
        <option value="">Select vendor…</option>
        ${vendors.map((v) => `<option value="${v.id}">${esc(v.name)} (${esc(v.code)})</option>`).join('')}
      </select>
      <select id="stmt-view">
        <option value="outstanding">Outstanding only</option>
        <option value="full">Full ledger</option>
      </select>
      <span id="stmt-export"></span>
    </div>
    <div id="stmt-body"><div class="card empty-state">Select a vendor to view their statement</div></div>`;
  const load = async () => {
    const vid = $('#stmt-vendor').value;
    if (!vid) { $('#stmt-body').innerHTML = '<div class="card empty-state">Select a vendor to view their statement</div>'; $('#stmt-export').innerHTML = ''; return; }
    const view = $('#stmt-view').value;
    const viewQs = view === 'full' ? '&view=full' : '';
    const d = await api(`/vendors/${vid}/statement${view === 'full' ? '?view=full' : ''}`);
    $('#stmt-export').innerHTML = `<a class="btn btn-sm" href="/api/vendors/${vid}/statement?format=csv&token=${encodeURIComponent(TOKEN)}${viewQs}">⬇ CSV</a>`;
    const emptyMsg = view === 'full' ? 'No ledger activity for this vendor' : 'Nothing outstanding — this vendor is fully settled';
    $('#stmt-body').innerHTML = `
      ${view === 'outstanding' ? '<p style="color:var(--text-muted);font-size:12.5px;margin-bottom:10px">Showing only invoices still owed. Switch to <strong>Full ledger</strong> to include settled invoices.</p>' : ''}
      <div class="card table-wrap"><table>
        <thead><tr><th>Date</th><th>JE</th><th>Type</th><th>Narration</th><th class="num">Debit</th><th class="num">Credit</th><th class="num">Balance owed</th></tr></thead>
        <tbody>${d.lines.length ? d.lines.map((l) => `
          <tr>
            <td>${fmtDate(l.je_date)}</td>
            <td>${esc(l.je_number)}</td>
            <td>${badge(l.type)}${l.tds_section ? ` <span class="badge badge-purple">TDS ${esc(l.tds_section)}</span>` : ''}</td>
            <td class="wrap">${esc(l.narration || '')}</td>
            <td class="num">${l.debit ? fmtMoney(l.debit) : ''}</td>
            <td class="num">${l.credit ? fmtMoney(l.credit) : ''}</td>
            <td class="num">${fmtMoney(l.balance)}</td>
          </tr>`).join('') : `<tr><td colspan="7" class="empty-state">${emptyMsg}</td></tr>`}
        </tbody>
        ${d.lines.length ? `<tfoot><tr style="background:var(--surface-2);font-weight:700"><td colspan="6">Closing balance owed to ${esc(d.vendor.name)}</td><td class="num">${fmtMoney(d.balance)}</td></tr></tfoot>` : ''}
      </table></div>`;
  };
  $('#stmt-vendor').addEventListener('change', load);
  $('#stmt-view').addEventListener('change', load);
}

// ---------- tax settings (admin) ----------
async function renderSettings(main) {
  const [departments, rules, users, outbox] = await Promise.all([
    api('/settings/departments'), api('/settings/approval-rules'), api('/users'), api('/settings/outbox'),
  ]);
  // tax masters exist only when the tax module is licensed
  const [gstins, sections, rcmCats, apCodes, subLocs, costCentres, fieldLabels, glLock] = has('tax')
    ? await Promise.all([
        api('/settings/gstins'), api('/settings/tds-sections'), api('/settings/rcm-categories'),
        api('/settings/ap-account-codes'), api('/settings/sub-locations'), api('/settings/cost-centres'),
        api('/settings/custom-field-labels'), api('/settings/gl-lock'),
      ])
    : [[], [], [], [], [], [], {}, {}];
  const userOpts = (sel) => users.filter((u) => u.active).map((u) => `<option value="${u.id}" ${sel === u.id ? 'selected' : ''}>${esc(u.full_name)}</option>`).join('');
  const codeOpts = (list, sel) => `<option value="">— none —</option>${list.map((c) => `<option value="${esc(c.code)}" ${sel === c.code ? 'selected' : ''}>${esc(c.code)} — ${esc(c.name)}</option>`).join('')}`;
  const ruleApprover = (r) => r.approver_kind === 'department_head' ? 'Department head'
    : r.approver_kind === 'role' ? `Role: ${esc(r.approver_ref)}`
    : esc((users.find((u) => u.id === Number(r.approver_ref)) || {}).full_name || `User #${r.approver_ref}`);
  main.innerHTML = `
    <div class="page-header"><div><h2>Settings</h2><div class="sub">Branding, departments, approval matrix${has('tax') ? ', GST registrations, TDS sections and RCM categories' : ''}</div></div></div>
    <div class="card card-pad" style="margin-bottom:16px">
      <h4 style="margin-bottom:10px">Departments</h4>
      <div class="table-wrap"><table>
        <thead><tr><th>Name</th><th>Department head</th><th>Deputy (backup approver)</th>
          ${has('tax') ? '<th>Default cost centre</th><th>Default sub-location</th>' : ''}
          <th class="num">Members</th><th>Status</th><th></th></tr></thead>
        <tbody>${departments.map((d) => `
          <tr>
            <td><strong>${esc(d.name)}</strong></td>
            <td><select data-dept-head="${d.id}" style="padding:6px 8px;border:1px solid var(--border);border-radius:8px">
              <option value="">— none —</option>${userOpts(d.head_user_id)}</select></td>
            <td><select data-dept-deputy="${d.id}" style="padding:6px 8px;border:1px solid var(--border);border-radius:8px">
              <option value="">— none —</option>${userOpts(d.deputy_user_id)}</select></td>
            ${has('tax') ? `
            <td><select data-dept-cc="${d.id}" style="padding:6px 8px;border:1px solid var(--border);border-radius:8px">${codeOpts(costCentres, d.default_cost_centre)}</select></td>
            <td><select data-dept-subloc="${d.id}" style="padding:6px 8px;border:1px solid var(--border);border-radius:8px">${codeOpts(subLocs, d.default_sub_location)}</select></td>` : ''}
            <td class="num">${d.member_count}</td>
            <td>${d.active ? badge('active') : badge('inactive')}</td>
            <td><button class="btn btn-sm" data-toggle-dept="${d.id}" data-active="${d.active}">${d.active ? 'Deactivate' : 'Activate'}</button></td>
          </tr>`).join('')}
        </tbody>
      </table></div>
      ${has('tax') ? '<p style="color:var(--text-muted);font-size:12px;margin-top:8px">Default cost centre/sub-location pre-fill the invoice approval form for that department — finance can still change it per invoice.</p>' : ''}
      <form id="dept-form" style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px;align-items:flex-end">
        <div class="field"><label>Department name</label><input name="name" required placeholder="e.g. Marketing" style="width:180px"></div>
        <div class="field"><label>Head</label><select name="head_user_id" style="min-width:160px"><option value="">— none —</option>${userOpts()}</select></div>
        <button type="submit" class="btn btn-primary btn-sm">+ Add department</button>
      </form>
    </div>
    <div class="card card-pad" style="margin-bottom:16px">
      <h4 style="margin-bottom:4px">Approval matrix</h4>
      <p style="color:var(--text-muted);font-size:12.5px;margin-bottom:10px">
        Rules route PRs and invoices for approval. Department-specific rules override "any department" rules;
        amount bands select which chain applies; levels are approved in order. Without a matching rule,
        PRs fall back to the approver role and invoices to finance.</p>
      <div class="table-wrap"><table>
        <thead><tr><th>Document</th><th>Department</th><th class="num">From ₹</th><th class="num">To ₹</th><th class="num">Level</th><th>Approver</th><th></th></tr></thead>
        <tbody>${rules.length ? rules.map((r) => `
          <tr>
            <td>${r.doc_type.toUpperCase()}</td>
            <td>${esc(r.department_name || 'Any')}</td>
            <td class="num">${fmtMoney(r.min_amount)}</td>
            <td class="num">${r.max_amount === null ? 'No limit' : fmtMoney(r.max_amount)}</td>
            <td class="num">${r.seq}</td>
            <td>${ruleApprover(r)}</td>
            <td><button class="btn btn-sm btn-danger" data-del-rule="${r.id}">Remove</button></td>
          </tr>`).join('') : '<tr><td colspan="7" class="empty-state">No rules — fallback approvals apply</td></tr>'}
        </tbody>
      </table></div>
      <form id="rule-form" style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px;align-items:flex-end">
        <div class="field"><label>Document</label>
          <select name="doc_type"><option value="pr">PR</option><option value="invoice">Invoice</option></select></div>
        <div class="field"><label>Department</label>
          <select name="department_id"><option value="">Any</option>${departments.filter((d) => d.active).map((d) => `<option value="${d.id}">${esc(d.name)}</option>`).join('')}</select></div>
        <div class="field"><label>From ₹</label><input name="min_amount" type="number" min="0" step="any" value="0" style="width:110px"></div>
        <div class="field"><label>To ₹ (blank = no limit)</label><input name="max_amount" type="number" min="0" step="any" style="width:130px"></div>
        <div class="field"><label>Level</label><input name="seq" type="number" min="1" max="5" value="1" style="width:70px"></div>
        <div class="field"><label>Approver</label>
          <select name="approver_kind" id="rule-kind">
            <option value="department_head">Department head</option>
            <option value="role">Role</option>
            <option value="user">Specific user</option>
          </select></div>
        <div class="field hidden" id="rule-role-field"><label>Role</label>
          <select name="approver_role">${['finance', 'procurement', 'approver', 'admin'].map((r) => `<option>${r}</option>`).join('')}</select></div>
        <div class="field hidden" id="rule-user-field"><label>User</label>
          <select name="approver_user">${userOpts()}</select></div>
        <button type="submit" class="btn btn-primary btn-sm">+ Add rule</button>
      </form>
    </div>
    <div class="card card-pad" style="margin-bottom:16px">
      <h4 style="margin-bottom:10px">Company logo</h4>
      <div style="display:flex;align-items:center;gap:18px;flex-wrap:wrap">
        <img id="logo-preview" src="/logo?t=${Date.now()}" alt="No logo uploaded"
             style="max-height:56px;max-width:220px;object-fit:contain;border:1px dashed var(--border);border-radius:8px;padding:6px;min-width:120px"
             onerror="this.alt='No logo uploaded yet';this.style.opacity=0.4">
        <form id="logo-form" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <input type="file" id="logo-file" accept=".png,.jpg,.jpeg">
          <button type="submit" class="btn btn-primary btn-sm">Upload logo</button>
          <button type="button" class="btn btn-sm" id="logo-remove">Remove</button>
        </form>
      </div>
      <p style="color:var(--text-muted);font-size:12px;margin-top:8px">
        PNG or JPG up to 2 MB. Shown above the P2PManager name on the login screens, staff sidebar and vendor portal.</p>
    </div>
    ${!has('tax') ? '' : `
    <div class="card card-pad" style="margin-bottom:16px">
      <h4 style="margin-bottom:4px">Company GST registrations</h4>
      <p style="color:var(--text-muted);font-size:12.5px;margin-bottom:10px">
        The 8 GL account codes map this GSTIN's postings (GST payable/input × CGST/SGST/IGST, plus RCM
        payable/input) into an external accounting system — optional until you need the export.</p>
      <div class="table-wrap"><table>
        <thead><tr><th>GSTIN</th><th>State</th><th>Label</th><th>Status</th><th></th></tr></thead>
        <tbody>${gstins.map((g) => `
          <tr><td>${esc(g.gstin)}</td><td>${esc(g.state_code)} ${esc(g.state_name)}</td><td>${esc(g.label)}</td>
          <td>${g.active ? badge('active') : badge('inactive')}</td>
          <td style="white-space:nowrap">
            <button class="btn btn-sm" data-edit-gstin='${JSON.stringify(g).replace(/'/g, "&#39;")}'>✏️ GL codes</button>
            <button class="btn btn-sm" data-toggle-gstin="${g.id}" data-active="${g.active}">${g.active ? 'Deactivate' : 'Activate'}</button>
          </td></tr>`).join('')}
        </tbody>
      </table></div>
      <form id="gstin-form" style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px;align-items:flex-end">
        <div class="field"><label>GSTIN</label><input name="gstin" required placeholder="27ABCDE1234F1Z3" maxlength="15" style="width:190px"></div>
        <div class="field"><label>State name</label><input name="state_name" placeholder="Maharashtra" style="width:150px"></div>
        <div class="field"><label>Label</label><input name="label" required placeholder="Mumbai Branch" style="width:150px"></div>
        <button type="submit" class="btn btn-primary btn-sm">+ Add registration</button>
      </form>
    </div>
    <div class="card card-pad" style="margin-bottom:16px">
      <h4 style="margin-bottom:10px">TDS / WHT sections</h4>
      <div class="table-wrap"><table>
        <thead><tr><th>Section</th><th>Description</th><th class="num">Rate %</th><th>Account code</th><th>Status</th><th></th></tr></thead>
        <tbody>${sections.map((s) => `
          <tr><td><strong>${esc(s.section)}</strong></td><td class="wrap">${esc(s.description)}</td><td class="num">${s.rate}</td>
          <td>${esc(s.account_code || '—')}</td>
          <td>${s.active ? badge('active') : badge('inactive')}</td>
          <td style="white-space:nowrap">
            <button class="btn btn-sm" data-edit-section='${JSON.stringify(s).replace(/'/g, "&#39;")}'>✏️</button>
            <button class="btn btn-sm" data-toggle-section="${s.id}" data-active="${s.active}">${s.active ? 'Deactivate' : 'Activate'}</button>
          </td></tr>`).join('')}
        </tbody>
      </table></div>
      <form id="section-form" style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px;align-items:flex-end">
        <div class="field"><label>Section</label><input name="section" required placeholder="194S" style="width:100px"></div>
        <div class="field"><label>Description</label><input name="description" required placeholder="Description" style="width:220px"></div>
        <div class="field"><label>Rate %</label><input name="rate" type="number" min="0" max="40" step="any" required style="width:90px"></div>
        <div class="field"><label>Account code</label><input name="account_code" placeholder="e.g. 2200-C" style="width:120px"></div>
        <button type="submit" class="btn btn-primary btn-sm">+ Add section</button>
      </form>
    </div>
    <div class="card card-pad" style="margin-bottom:16px">
      <h4 style="margin-bottom:10px">RCM categories</h4>
      <div class="table-wrap"><table>
        <thead><tr><th>Name</th><th>Description</th></tr></thead>
        <tbody>${rcmCats.map((c) => `<tr><td><strong>${esc(c.name)}</strong></td><td class="wrap">${esc(c.description || '')}</td></tr>`).join('')}</tbody>
      </table></div>
      <form id="rcm-form" style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px;align-items:flex-end">
        <div class="field"><label>Name</label><input name="name" required style="width:200px"></div>
        <div class="field"><label>Description</label><input name="description" style="width:280px"></div>
        <button type="submit" class="btn btn-primary btn-sm">+ Add category</button>
      </form>
    </div>
    <div class="card card-pad" style="margin-bottom:16px">
      <h4 style="margin-bottom:4px">GL reference masters</h4>
      <p style="color:var(--text-muted);font-size:12.5px;margin-bottom:10px">
        Simple code + name lists. AP Account Codes are selected on the vendor record; Sub-locations and
        Cost Centres are selected (or department-defaulted) at invoice final approval.</p>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:16px">
        ${[
          { key: 'ap-account-codes', title: 'AP Account Codes', list: apCodes },
          { key: 'sub-locations', title: 'Sub-locations', list: subLocs },
          { key: 'cost-centres', title: 'Cost Centres', list: costCentres },
        ].map(({ key, title, list }) => `
        <div>
          <h5 style="margin-bottom:8px">${title}</h5>
          <div class="table-wrap"><table>
            <thead><tr><th>Code</th><th>Name</th><th>Status</th><th></th></tr></thead>
            <tbody>${list.length ? list.map((c) => `
              <tr><td>${esc(c.code)}</td><td class="wrap">${esc(c.name)}</td>
              <td>${c.active ? badge('active') : badge('inactive')}</td>
              <td><button class="btn btn-sm" data-toggle-code="${key}:${c.id}" data-active="${c.active}">${c.active ? 'Off' : 'On'}</button></td></tr>`).join('')
              : '<tr><td colspan="4" class="empty-state">None yet</td></tr>'}
            </tbody>
          </table></div>
          <form data-code-form="${key}" style="display:flex;gap:6px;margin-top:8px">
            <input name="code" placeholder="Code" style="width:80px" required>
            <input name="name" placeholder="Name" style="flex:1" required>
            <button type="submit" class="btn btn-sm">+ Add</button>
          </form>
        </div>`).join('')}
      </div>
    </div>
    <div class="card card-pad">
      <h4 style="margin-bottom:4px">GL period lock (month-end close)</h4>
      <p style="color:var(--text-muted);font-size:12.5px;margin-bottom:10px">
        Every month up to and including the locked month is <strong>closed</strong>: no journal entry — invoice
        booking, payment, or tax deposit — can post into it. Clear the field to reopen. Finance or admin only.</p>
      <form id="gl-lock-form" style="display:flex;gap:10px;align-items:center">
        <input name="locked_through" type="month" value="${esc(glLock.locked_through || '')}" style="max-width:180px">
        <button type="submit" class="btn btn-primary">Save lock</button>
        <span style="color:var(--text-muted);font-size:12.5px">${glLock.locked_through ? `Books currently closed through ${esc(glLock.locked_through)}` : 'No period is locked'}</span>
      </form>
    </div>

    <div class="card card-pad" style="margin-top:14px">
      <h4 style="margin-bottom:4px">Custom field labels</h4>
      <p style="color:var(--text-muted);font-size:12.5px;margin-bottom:10px">
        Rename the 5 spare invoice fields (captured at final approval) for this client's own reporting needs
        — e.g. "Custom Field 1" → "Project Code".</p>
      <form id="custom-labels-form" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px">
        ${[1, 2, 3, 4, 5].map((i) => `
        <div class="field"><label>Custom Field ${i}</label><input name="custom_field_${i}" value="${esc(fieldLabels[`custom_field_${i}`] || '')}"></div>`).join('')}
        <div style="grid-column:1/-1"><button type="submit" class="btn btn-primary btn-sm">Save labels</button></div>
      </form>
    </div>`}
    <div class="card card-pad" style="margin-top:16px">
      <h4 style="margin-bottom:4px">Email notifications — outbox</h4>
      <p style="color:var(--text-muted);font-size:12.5px;margin-bottom:10px">
        Latest 100 notifications. Status <strong>logged</strong> means SMTP is not configured — the app records
        what it would have sent. Set <code>SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS / SMTP_FROM / APP_URL</code>
        in the server environment to actually send.</p>
      <div class="table-wrap" style="max-height:340px;overflow-y:auto"><table>
        <thead><tr><th>When</th><th>To</th><th>Subject</th><th>Status</th></tr></thead>
        <tbody>${outbox.length ? outbox.map((m) => `
          <tr>
            <td style="white-space:nowrap">${fmtDate(m.created_at)}</td>
            <td>${esc(m.to_email)}</td>
            <td class="wrap">${esc(m.subject)}</td>
            <td>${badge(m.status === 'sent' ? 'approved' : m.status === 'failed' ? 'rejected' : 'draft').replace(/>[a-z]+</, `>${m.status}<`)}${m.error ? `<div style="font-size:11px;color:var(--red)">${esc(m.error)}</div>` : ''}</td>
          </tr>`).join('') : '<tr><td colspan="4" class="empty-state">No notifications yet</td></tr>'}
        </tbody>
      </table></div>
    </div>`;

  // departments
  $('#dept-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/settings/departments', { method: 'POST', body: Object.fromEntries(new FormData(e.target).entries()) });
      TAXMETA = null; toast('Department added', 'success'); route();
    } catch (err) { toast(err.message, 'error'); }
  });
  main.querySelectorAll('[data-dept-head]').forEach((sel) => sel.addEventListener('change', async () => {
    try {
      await api('/settings/departments/' + sel.dataset.deptHead, { method: 'PUT', body: { head_user_id: sel.value } });
      TAXMETA = null; toast('Department head updated', 'success');
    } catch (err) { toast(err.message, 'error'); }
  }));
  main.querySelectorAll('[data-dept-deputy]').forEach((sel) => sel.addEventListener('change', async () => {
    try {
      await api('/settings/departments/' + sel.dataset.deptDeputy, { method: 'PUT', body: { deputy_user_id: sel.value } });
      TAXMETA = null; toast('Deputy updated', 'success');
    } catch (err) { toast(err.message, 'error'); }
  }));
  main.querySelectorAll('[data-toggle-dept]').forEach((b) => b.addEventListener('click', () =>
    api('/settings/departments/' + b.dataset.toggleDept, { method: 'PUT', body: { active: b.dataset.active === '1' ? 0 : 1 } })
      .then(() => { TAXMETA = null; route(); }).catch((err) => toast(err.message, 'error'))));
  main.querySelectorAll('[data-dept-cc]').forEach((sel) => sel.addEventListener('change', async () => {
    try {
      await api('/settings/departments/' + sel.dataset.deptCc, { method: 'PUT', body: { default_cost_centre: sel.value } });
      toast('Default cost centre updated', 'success');
    } catch (err) { toast(err.message, 'error'); }
  }));
  main.querySelectorAll('[data-dept-subloc]').forEach((sel) => sel.addEventListener('change', async () => {
    try {
      await api('/settings/departments/' + sel.dataset.deptSubloc, { method: 'PUT', body: { default_sub_location: sel.value } });
      toast('Default sub-location updated', 'success');
    } catch (err) { toast(err.message, 'error'); }
  }));

  // approval matrix
  $('#rule-kind').addEventListener('change', (e) => {
    $('#rule-role-field').classList.toggle('hidden', e.target.value !== 'role');
    $('#rule-user-field').classList.toggle('hidden', e.target.value !== 'user');
  });
  $('#rule-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target).entries());
    try {
      await api('/settings/approval-rules', {
        method: 'POST',
        body: {
          doc_type: f.doc_type, department_id: f.department_id, min_amount: f.min_amount,
          max_amount: f.max_amount, seq: f.seq, approver_kind: f.approver_kind,
          approver_ref: f.approver_kind === 'role' ? f.approver_role : f.approver_kind === 'user' ? f.approver_user : null,
        },
      });
      toast('Rule added', 'success'); route();
    } catch (err) { toast(err.message, 'error'); }
  });
  main.querySelectorAll('[data-del-rule]').forEach((b) => b.addEventListener('click', () =>
    api('/settings/approval-rules/' + b.dataset.delRule, { method: 'DELETE' })
      .then(() => { toast('Rule removed', 'success'); route(); }).catch((err) => toast(err.message, 'error'))));

  $('#logo-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const file = $('#logo-file').files[0];
    if (!file) return toast('Choose a PNG or JPG file first', 'error');
    const fd = new FormData();
    fd.append('logo', file);
    try {
      await api('/settings/logo', { method: 'POST', body: fd });
      toast('Logo updated — refresh to see it everywhere', 'success');
      route();
    } catch (err) { toast(err.message, 'error'); }
  });
  $('#logo-remove').addEventListener('click', async () => {
    try {
      await api('/settings/logo', { method: 'DELETE' });
      toast('Logo removed', 'success');
      route();
    } catch (err) { toast(err.message, 'error'); }
  });

  const post = (url, body, msg) => api(url, { method: 'POST', body })
    .then(() => { TAXMETA = null; toast(msg, 'success'); route(); })
    .catch((err) => toast(err.message, 'error'));
  // the tax-master cards exist only when the tax module is licensed
  $('#gstin-form')?.addEventListener('submit', (e) => {
    e.preventDefault();
    post('/settings/gstins', Object.fromEntries(new FormData(e.target).entries()), 'Registration added');
  });
  $('#section-form')?.addEventListener('submit', (e) => {
    e.preventDefault();
    post('/settings/tds-sections', Object.fromEntries(new FormData(e.target).entries()), 'Section added');
  });
  $('#rcm-form')?.addEventListener('submit', (e) => {
    e.preventDefault();
    post('/settings/rcm-categories', Object.fromEntries(new FormData(e.target).entries()), 'Category added');
  });
  main.querySelectorAll('[data-toggle-gstin]').forEach((b) => b.addEventListener('click', () =>
    api('/settings/gstins/' + b.dataset.toggleGstin, { method: 'PUT', body: { active: b.dataset.active === '1' ? 0 : 1 } })
      .then(() => { TAXMETA = null; route(); }).catch((err) => toast(err.message, 'error'))));
  main.querySelectorAll('[data-toggle-section]').forEach((b) => b.addEventListener('click', () =>
    api('/settings/tds-sections/' + b.dataset.toggleSection, { method: 'PUT', body: { active: b.dataset.active === '1' ? 0 : 1 } })
      .then(() => { TAXMETA = null; route(); }).catch((err) => toast(err.message, 'error'))));

  // GSTIN GL-code editor (8 fields: 3 GST payable, 3 GST input, RCM payable, RCM input)
  const GSTIN_GL_FIELDS = [
    ['gst_payable_cgst_code', 'GST Payable — CGST'], ['gst_payable_sgst_code', 'GST Payable — SGST'], ['gst_payable_igst_code', 'GST Payable — IGST'],
    ['gst_input_cgst_code', 'GST Input — CGST'], ['gst_input_sgst_code', 'GST Input — SGST'], ['gst_input_igst_code', 'GST Input — IGST'],
    ['gst_rcm_payable_code', 'GST-RCM Payable'], ['gst_rcm_input_code', 'GST-RCM Input'],
  ];
  main.querySelectorAll('[data-edit-gstin]').forEach((b) => b.addEventListener('click', () => {
    const g = JSON.parse(b.dataset.editGstin);
    openModal(`GL account codes — ${g.label}`, `
      <form id="gstin-codes-form">
        <div class="form-grid">
          ${GSTIN_GL_FIELDS.map(([f, label]) => `
          <div class="field"><label>${label}</label><input name="${f}" value="${esc(g[f] || '')}"></div>`).join('')}
        </div>
        <div class="form-actions">
          <button type="button" class="btn" onclick="closeModal()">Cancel</button>
          <button type="submit" class="btn btn-primary">Save codes</button>
        </div>
      </form>`);
    $('#gstin-codes-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await api('/settings/gstins/' + g.id, { method: 'PUT', body: Object.fromEntries(new FormData(e.target).entries()) });
        toast('GL codes saved', 'success');
        TAXMETA = null; closeModal(); route();
      } catch (err) { toast(err.message, 'error'); }
    });
  }));

  main.querySelectorAll('[data-edit-section]').forEach((b) => b.addEventListener('click', () => {
    const s = JSON.parse(b.dataset.editSection);
    openModal(`Edit TDS section — ${s.section}`, `
      <form id="section-edit-form">
        <div class="form-grid">
          <div class="field full"><label>Description</label><input name="description" value="${esc(s.description)}" required></div>
          <div class="field"><label>Rate %</label><input name="rate" type="number" min="0" max="40" step="any" value="${s.rate}" required></div>
          <div class="field"><label>Account code</label><input name="account_code" value="${esc(s.account_code || '')}"></div>
        </div>
        <div class="form-actions">
          <button type="button" class="btn" onclick="closeModal()">Cancel</button>
          <button type="submit" class="btn btn-primary">Save</button>
        </div>
      </form>`);
    $('#section-edit-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await api('/settings/tds-sections/' + s.id, { method: 'PUT', body: Object.fromEntries(new FormData(e.target).entries()) });
        toast('Section updated', 'success');
        TAXMETA = null; closeModal(); route();
      } catch (err) { toast(err.message, 'error'); }
    });
  }));

  // GL reference masters: AP account codes / sub-locations / cost centres — same CRUD shape
  main.querySelectorAll('[data-code-form]').forEach((form) => form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const entity = form.dataset.codeForm;
    try {
      await api(`/settings/${entity}`, { method: 'POST', body: Object.fromEntries(new FormData(e.target).entries()) });
      TAXMETA = null; toast('Added', 'success'); route();
    } catch (err) { toast(err.message, 'error'); }
  }));
  main.querySelectorAll('[data-toggle-code]').forEach((b) => b.addEventListener('click', () => {
    const [entity, id] = b.dataset.toggleCode.split(':');
    api(`/settings/${entity}/${id}`, { method: 'PUT', body: { active: b.dataset.active === '1' ? 0 : 1 } })
      .then(() => { TAXMETA = null; route(); }).catch((err) => toast(err.message, 'error'));
  }));

  $('#custom-labels-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/settings/custom-field-labels', { method: 'PUT', body: Object.fromEntries(new FormData(e.target).entries()) });
      TAXMETA = null; toast('Labels saved', 'success');
    } catch (err) { toast(err.message, 'error'); }
  });

  $('#gl-lock-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const r = await api('/settings/gl-lock', { method: 'PUT', body: Object.fromEntries(new FormData(e.target).entries()) });
      toast(r.locked_through ? `Books closed through ${r.locked_through}` : 'GL period lock removed', 'success');
      route();
    } catch (err) { toast(err.message, 'error'); }
  });
}

// ---------- users (admin) ----------
async function renderUsers(main) {
  const users = await api('/users');
  main.innerHTML = `
    <div class="page-header">
      <div><h2>Users &amp; Roles</h2><div class="sub">Access control for the P2P workflow</div></div>
      <button class="btn btn-primary" id="btn-new-user">+ New user</button>
    </div>
    <div class="card table-wrap"><table>
      <thead><tr><th>Username</th><th>Name</th><th>Email</th><th>Role</th><th>Department</th><th>2FA</th><th>Status</th><th>Created</th><th></th></tr></thead>
      <tbody>${users.map((u) => `
        <tr>
          <td><strong>${esc(u.username)}</strong></td>
          <td>${esc(u.full_name)}</td>
          <td>${esc(u.email || '—')}</td>
          <td>${badge(u.role === 'admin' ? 'approved' : 'submitted').replace(/>.*</, `>${esc(u.role)}<`)}</td>
          <td>${esc(u.department_name || '—')}</td>
          <td>${u.totp_enabled ? badge('approved').replace('approved', 'on') : badge('draft').replace('draft', 'off')}</td>
          <td>${u.active ? badge('active') : badge('inactive')}</td>
          <td>${fmtDate(u.created_at)}</td>
          <td><button class="btn btn-sm" onclick='openUserForm(${JSON.stringify(u).replace(/'/g, "&#39;")})'>Edit</button></td>
        </tr>`).join('')}
      </tbody>
    </table></div>
    <div class="card card-pad" style="margin-top:14px">
      <h4 style="margin-bottom:8px">Role permissions</h4>
      <div style="font-size:13px;color:var(--text-muted);line-height:1.9">
        <strong>admin</strong> — everything, including user management ·
        <strong>procurement</strong> — vendors, POs, GRNs ·
        <strong>finance</strong> — vendors, invoices, payments ·
        <strong>approver</strong> — approve/reject PRs and invoices ·
        <strong>requester</strong> — raise PRs and view records
      </div>
    </div>`;
  $('#btn-new-user').addEventListener('click', () => openUserForm(null));
}

window.openUserForm = async function (u) {
  const isEdit = !!u;
  u = u || {};
  const meta = await taxMeta();
  openModal(isEdit ? `Edit user — ${u.username}` : 'New user', `
    <form id="user-form">
      <div class="form-grid">
        ${isEdit ? '' : `<div class="field"><label>Username *</label><input name="username" required autocomplete="off"></div>`}
        <div class="field"><label>Full name *</label><input name="full_name" required value="${esc(u.full_name || '')}"></div>
        <div class="field"><label>Email</label><input name="email" type="email" value="${esc(u.email || '')}"></div>
        <div class="field"><label>Role *</label>
          <select name="role" required>
            ${['admin', 'procurement', 'finance', 'approver', 'requester'].map((r) => `<option value="${r}" ${u.role === r ? 'selected' : ''}>${r}</option>`).join('')}
          </select></div>
        <div class="field"><label>Department</label>
          <select name="department_id">
            <option value="">— none —</option>
            ${meta.departments.map((d) => `<option value="${d.id}" ${u.department_id === d.id ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}
          </select></div>
        <div class="field"><label>${isEdit ? 'Reset password (leave blank to keep)' : 'Password *'}</label>
          <input name="password" type="password" ${isEdit ? '' : 'required'} autocomplete="new-password" minlength="8"></div>
        ${isEdit ? `<div class="field"><label>Status</label>
          <select name="active"><option value="1" ${u.active ? 'selected' : ''}>Active</option><option value="0" ${u.active ? '' : 'selected'}>Inactive</option></select></div>` : ''}
        ${isEdit && u.totp_enabled ? `<div class="field full" style="display:flex;align-items:center;gap:8px">
          <input type="checkbox" name="reset_totp" id="reset-totp" value="1" style="width:auto">
          <label for="reset-totp" style="margin:0">Reset two-factor auth (lost phone) — user signs in with password only and re-enrols</label></div>` : ''}
      </div>
      <div class="form-actions">
        <button type="button" class="btn" onclick="closeModal()">Cancel</button>
        <button type="submit" class="btn btn-primary">${isEdit ? 'Save changes' : 'Create user'}</button>
      </div>
    </form>`);
  $('#user-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target).entries());
    try {
      if (isEdit) {
        await api('/users/' + u.id, { method: 'PUT', body: { ...f, active: Number(f.active), password: f.password || undefined } });
      } else {
        await api('/users', { method: 'POST', body: f });
      }
      toast(isEdit ? 'User updated' : 'User created', 'success');
      closeModal(); route();
    } catch (err) { toast(err.message, 'error'); }
  });
};

// ---------- two-factor auth ----------
async function openTotpModal() {
  const me = await api('/auth/me');
  if (!me.totp_enabled) {
    let setup;
    try { setup = await api('/auth/totp/setup', { method: 'POST' }); }
    catch (err) { return toast(err.message, 'error'); }
    openModal('Enable two-factor authentication', `
      <ol style="margin:0 0 16px 18px;line-height:1.9;font-size:13.5px">
        <li>Install an authenticator app (Google Authenticator, Microsoft Authenticator, Authy…)</li>
        <li>Scan this QR code with the app</li>
        <li>Enter the 6-digit code it shows to confirm</li>
      </ol>
      <div style="text-align:center;margin-bottom:14px">
        <img src="${setup.qr}" alt="TOTP QR code" style="border:1px solid var(--border);border-radius:10px">
        <div style="color:var(--text-muted);font-size:12px;margin-top:8px">
          Can't scan? Enter this key manually:<br><code style="user-select:all">${esc(setup.secret)}</code>
        </div>
      </div>
      <form id="totp-enable-form">
        <div class="field"><label>6-digit code from the app</label>
          <input name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" required autocomplete="one-time-code"></div>
        <div class="form-actions">
          <button type="button" class="btn" onclick="closeModal()">Cancel</button>
          <button type="submit" class="btn btn-primary">Confirm &amp; enable</button>
        </div>
      </form>`);
    $('#totp-enable-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await api('/auth/totp/enable', { method: 'POST', body: { code: new FormData(e.target).get('code') } });
        toast('Two-factor authentication enabled — you will be asked for a code at every sign-in', 'success');
        closeModal();
      } catch (err) { toast(err.message, 'error'); }
    });
  } else {
    openModal('Two-factor authentication', `
      <p style="margin-bottom:16px">✅ Two-factor authentication is <strong>enabled</strong> on your account.
      To disable it (or re-enrol a new phone), confirm your password and a current code:</p>
      <form id="totp-disable-form">
        <div class="form-grid">
          <div class="field"><label>Password</label><input name="password" type="password" required autocomplete="current-password"></div>
          <div class="field"><label>Authenticator code</label>
            <input name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" required autocomplete="one-time-code"></div>
        </div>
        <div class="form-actions">
          <button type="button" class="btn" onclick="closeModal()">Cancel</button>
          <button type="submit" class="btn btn-danger">Disable 2FA</button>
        </div>
      </form>`);
    $('#totp-disable-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await api('/auth/totp/disable', { method: 'POST', body: Object.fromEntries(new FormData(e.target).entries()) });
        toast('Two-factor authentication disabled', 'success');
        closeModal();
      } catch (err) { toast(err.message, 'error'); }
    });
  }
}

// ---------- change password ----------
function openChangePassword() {
  openModal('Change password', `
    <form id="pw-form">
      <div class="form-grid">
        <div class="field full"><label>Current password</label><input name="current_password" type="password" required autocomplete="current-password"></div>
        <div class="field full"><label>New password (min 8 chars, letters &amp; numbers)</label><input name="new_password" type="password" required minlength="8" autocomplete="new-password"></div>
      </div>
      <div class="form-actions">
        <button type="button" class="btn" onclick="closeModal()">Cancel</button>
        <button type="submit" class="btn btn-primary">Update password</button>
      </div>
    </form>`);
  $('#pw-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target).entries());
    try {
      await api('/auth/change-password', { method: 'POST', body: f });
      toast('Password updated', 'success');
      closeModal();
    } catch (err) { toast(err.message, 'error'); }
  });
}

// ---------- boot ----------
(async function boot() {
  if (!TOKEN) return showLogin();
  try {
    USER = await api('/auth/me');
    localStorage.setItem('p2p_user', JSON.stringify(USER));
    showApp();
  } catch {
    /* api() already logged out on 401 */
  }
})();
