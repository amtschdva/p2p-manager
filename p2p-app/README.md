# P2P Manager — Procure-to-Pay Web App

A self-contained procure-to-pay management application: vendor (AP) master data,
purchase requisitions, purchase orders, goods receipts, invoices with automatic
3-way matching, payments, and a live dashboard — plus a **self-service vendor
portal** at `/vendor` where suppliers register themselves, submit invoices with
attachments, and track payments.

## Stack

- **Backend**: Node.js + Express, **PostgreSQL 16** (bundled in the Docker deployment)
- **Auth**: JWT (8h expiry) with bcrypt-hashed passwords and role-based authorization;
  separate token kinds for staff and vendor accounts
- **Frontend**: vanilla JS single-page apps (staff app + vendor portal) + Chart.js (CDN)
- **Data**: PostgreSQL (`DATABASE_URL`, schema auto-created and seeded on first
  run); uploaded files (invoice attachments, vendor KYC docs, logo) in `data/`
- **Tests**: `npm test` — end-to-end API suite (auth, approval chains, KYC,
  3-way match, JE balance, maker-checker, GSTR-2B recon) against a dedicated
  test database

## Run

```bash
# one-time: local PostgreSQL for development
docker run -d --name p2p-postgres --restart unless-stopped \
  -e POSTGRES_USER=p2p -e POSTGRES_PASSWORD=p2p -e POSTGRES_DB=p2p \
  -p 5433:5432 postgres:16-alpine

npm install
npm start          # staff app: http://localhost:9138 · vendor portal: http://localhost:9138/vendor
```

`DATABASE_URL` defaults to `postgres://p2p:p2p@localhost:5433/p2p` for development.
`npm run dev` restarts on file changes; `npm run seed` wipes the database and reseeds
demo data; `npm test` runs the API test suite (uses a separate `p2p_test` database).
Set `JWT_SECRET` in production (otherwise a random secret is generated per restart, which
invalidates sessions on restart). `PORT` overrides the default 9138.

**Production deployment** (Docker + Traefik + HTTPS + backups): see
[deploy/DEPLOY.md](deploy/DEPLOY.md). The app refuses to start with
`NODE_ENV=production` unless `JWT_SECRET` is set, and ships with **TOTP two-factor
authentication** (sidebar → Two-factor auth; works with Google/Microsoft
Authenticator and Authy; admins can reset a user's 2FA from the Users page),
login/registration rate limiting, helmet security headers, a password policy
(8+ chars, letters + numbers), and upload file-signature validation.

## Demo accounts

| Username | Password  | Role        | Can do |
|----------|-----------|-------------|--------|
| admin    | admin123  | admin       | Everything, incl. user management |
| priya    | priya123  | procurement | Vendors (incl. verification), POs, GRNs |
| rahul    | rahul123  | finance     | Vendors, invoices, payments |
| meera    | meera123  | approver    | Approve/reject PRs, GRNs and invoices |
| vikram   | vikram123 | requester   | Raise PRs, view records |
| sneha    | sneha123  | finance     | Finance clerk (prepares payments; Rahul, the Finance head, releases) |

Vendor portal (`/vendor`): `vendor@techsupply.in / vendor123` (verified) and, on a
freshly seeded database, `deepak@nimbuscloud.in / nimbus123` (pending verification).

## Departments & approval matrix

- **Departments** (Settings, admin): each has a **department head**; users are
  assigned to departments (Users page).
- **Approval matrix** (Settings, admin): rules per document type (PR / invoice),
  optionally per department and amount band, with multi-level chains — each
  level is the *department head*, a *role*, or a *specific user*. Department
  rules override "any department" rules; levels approve in order; admin can
  always act to unblock a chain. Without a rule: PRs fall back to the approver
  role, invoices to finance.
- **Amount-band escalation**: bands per document type route bigger spends
  through more levels. Seeded demo DOA — PRs ≤ ₹5L → department head; above →
  head + admin. Invoices ≤ ₹10L → head + finance; above → head + finance +
  admin. Overlapping bands are rejected when rules are added, so every amount
  matches exactly one band per level.
- **Live chain preview**: the PR and invoice forms show "who will approve this?"
  as you type the amounts (also available at `GET /api/approvals/preview`).
- **Deputy approvers**: each department can have a deputy who can act on
  department-head levels (and is notified alongside the head).
- **Segregation of duties**: whoever created a document can never approve any
  of its levels — enforced across PRs and invoices (admin can still unblock).
- **Department-scoped visibility**: PRs and invoices are visible only to users
  connected to their department — the department's own members, its head, and
  its deputy (a deputy covering another department therefore sees that
  department's documents too, matching how the matrix routes approvals to
  them). A document's creator can always see it. **Finance, procurement and
  admin see every department's documents** — finance processes all of them,
  procurement converts any department's PRs into POs. The dashboard's Recent
  Activity works the same way: finance/admin see the full stream, everyone
  else sees only their own actions.
- **Stale-approval reminders**: anything pending longer than
  `REMIND_AFTER_DAYS` (default 3) re-notifies the current approvers, repeated
  at most every N days.
- Invoices with no department of their own (e.g. vendor-portal submissions)
  inherit the PO owner's department; an unresolvable head level is skipped so
  chains never stall.
- **Payment releases are reserved for the head of the department named
  "Finance"** (or admin) — on top of maker-checker. If no Finance head is
  configured, any other finance user may release.
- **Any staff user can enter an invoice** against a PO on behalf of vendors that
  won't use the portal (telco, electricity…), with an attachment; it routes
  through the matrix and **finance always gives the final approval**, where TDS
  is selected and the journal entry is posted.

## Workflow

1. **PR** — anyone raises a purchase requisition with line items; it routes to
   the approval chain from the matrix (normally the department head;
   self-approval is blocked).
2. **PO** — procurement converts an approved PR to a purchase order (or raises a
   direct PO) against an *active* vendor.
3. **GRN** — procurement records deliveries against PO lines (over-receiving is
   blocked), then an **approver reviews the GRN**. Only approved receipts count
   toward PO completion and invoice matching.
4. **Invoice** — finance enters the vendor invoice against a PO, or the vendor
   submits it via the portal (with a PDF/image copy attached). Either way it is
   automatically **3-way matched** (PO value vs approved goods receipts vs
   invoiced value, 2% tolerance, cumulative across invoices to catch duplicates).
   Mismatches are flagged, and pending invoices are re-matched automatically when
   a GRN is later approved.
5. **Payment (maker-checker)** — a finance user *prepares* a payment against an
   approved invoice (no accounting effect; pending payments reserve the
   outstanding balance and appear in a **bank bulk-upload CSV** with beneficiary
   account details). A **different** finance user (or admin) *releases* it —
   only then is the journal posted, the invoice marked paid/partially-paid, and
   the vendor notified with a payment advice. Overpayment is blocked net of TDS.

Every action is recorded in an audit log shown on the dashboard.

## Notifications & My Approvals

- **My Approvals** (sidebar) is each user's inbox: PRs and invoices awaiting
  their approval level, GRNs to review (approvers), vendors to verify and
  payments to release (finance). The dashboard shows an "Awaiting your action"
  card with the live count.
- **Email notifications** fire on every workflow hand-off: PR/invoice awaiting
  approval (to exactly the level's approvers), approval/rejection outcomes back
  to the requester or vendor, GRN review requests, vendor registration alerts
  to finance, verification results to the vendor, payment-release requests to
  finance checkers (excluding the maker), and payment advices to vendors.
- Configure SMTP via `SMTP_HOST/PORT/SECURE/USER/PASS/FROM` and `APP_URL` (link
  target in emails). **Without SMTP the app works normally** — every
  notification is recorded in the outbox, viewable under Settings (admin).

## Tax & accounting (India)

- **Multi-GSTIN**: the company's GST registrations live in Tax Settings (admin).
  Each PO selects the buying registration; invoices inherit it with override.
  Intra-state (CGST+SGST) vs inter-state (IGST) is suggested automatically from
  the vendor's GSTIN state code vs the registration's state.
- **TDS/WHT**: at invoice approval, finance picks the section (194C/194J/194I/
  194H/194Q/194A/195 seeded, editable master) and rate; TDS is computed on the
  taxable value. Payments are capped at total − TDS.
- **RCM**: overseas vendors are booked as import of services automatically;
  domestic RCM categories (legal, GTA, sponsorship…) are selectable. IGST is
  self-assessed (Dr GST Input IGST-RCM / Cr RCM GST Payable) and not payable to
  the vendor.
- **Duplicate-invoice control**: the same vendor reference can only be
  recorded once per vendor (case/whitespace-insensitive) across staff entry
  and the vendor portal; rejected/cancelled invoices don't block a corrected
  resubmission.
- **GL period lock (month-end close)**: finance/admin closes the books
  through a month (Settings → GL period lock). Nothing can post a journal
  entry — invoice booking, payment release, or tax deposit — into the locked
  month or earlier; clear the lock to reopen.
- **TDS rate discipline**: at final approval the rate must match the section
  master (or, when a lower-deduction certificate is claimed, exactly the
  certificate's rate). Finance can deviate from the master only with an
  explicit override reason, which is recorded in the audit trail. The GL
  period must also be a valid YYYY-MM month.
- **Journal entries** are auto-posted, immutable and balanced: booking (AP
  credited **gross** with TDS as a separate AP debit line), payment, and tax
  deposits. Export as CSV or Excel from the Journal page.
- **Vendor statements**: per-vendor AP ledger showing invoices, TDS deductions
  and payments with a running balance (CSV export).
- **TDS & RCM deposits**: month/section-wise liability vs challans (challan no.,
  BSR code); recording a challan posts the deposit JE.
- **GSTR-2B reconciliation**: upload the 2B CSV per registration per period
  (headers `supplier_gstin,invoice_no,invoice_date,taxable_value,cgst,sgst,igst`);
  invoices are flagged matched / value-mismatch / not-in-2B, plus a list of 2B
  lines missing from the books. A sample file is in `samples/`.

### GL / external accounting integration

Invoices capture a broader set of fields so a booked JE can feed any
downstream accounting system (Tally, SUN6, MS Dynamics, ...), not just this
app's own ledger:

- **Invoice Receipt Date** (separate from the vendor's invoice date) drives
  **due date auto-calculation**: receipt date + the vendor's payment-terms
  days (`payment_terms_days`, editable per vendor). An explicit due date
  always overrides the calculation.
- **Place of Supply** auto-derives from the vendor's GSTIN (first 2 digits)
  but stays editable, and **HSN/SAC Code** — both are compulsory once the
  vendor is GST-registered.
- **Lower/nil TDS deduction certificates** — capture rate, an optional
  threshold amount, validity window, and the certificate document per
  vendor+section (🎫 button on the Vendors page and vendor edit form). A
  certificate valid for the chosen section on the invoice date suggests its
  rate at final approval instead of the section's master rate; finance can
  still override. The lower rate applies only until invoices booked against
  the certificate reach its threshold (if it has one) or its validity window
  closes — whichever comes first; the certificate list shows how much of the
  threshold remains, and approval is rejected if using it would exceed it.
  A vendor with a currently-usable certificate shows a **🎫 LDC** badge next
  to its name on the Vendors page; the certificate list itself flags each one
  as Active, Expired, Not yet valid, or Exhausted (threshold used up).
- **GL account codes** — an AP account code per vendor (each vendor is its own
  GL control account, so a code can only ever be assigned to one vendor at a
  time — the vendor form greys out codes already taken and the API rejects a
  duplicate assignment). Finance assigns it as part of **Verify & activate**
  (required there unless already set), so every active vendor is guaranteed
  one. There are also GST payable/input codes (CGST/SGST/IGST) and GST-RCM
  payable/input codes per company GSTIN, and an account code per TDS section.
  Each is resolved and frozen as text onto every journal line at posting
  time — a later master-data rename never rewrites history.
- **GL classification dimensions** — Sub-location and Cost Centre (simple
  code+name master tables under Settings, selected at invoice final approval;
  a department can set defaults that pre-fill the dropdown), a free-text
  Program/Product Code, a 50-character Description, a GL Period (defaults to
  the invoice month), and 5 relabelable custom fields (Settings → Custom
  field labels) for anything else a client's chart of accounts needs.
- All of the above are exported alongside the existing account code/debit/
  credit columns from the Journal page's CSV/Excel export — the same generic
  export now doubles as the GL-import bridge for whichever accounting system
  a client uses.

## Vendor onboarding & KYC documents

- **Any staff user can propose a vendor**; it starts *unverified/inactive* and
  enters the finance verification queue (same for portal self-registrations).
- **KYC documents** are captured per vendor — PAN card and cancelled cheque
  (required for domestic vendors), GSTIN certificate (required only when the
  vendor has a GSTIN on the master, i.e. is GST-registered) and MSME
  certificate (optional) — uploaded by staff (📄 button on the Vendors page) or
  by the vendor from Company Profile in the portal. Files live in
  `data/vendor-docs/<vendor-id>/`, one live file per type (re-upload replaces),
  with uploader and timestamp tracked and file-signature validation applied.
- **Only finance (or admin) can verify a vendor**, and the server refuses to
  verify a domestic vendor until the required documents are on file and PAN is
  filled in the master. Verification activates the vendor; POs can only be
  raised on active vendors.

## Vendor portal

- **Self-registration** at `/vendor` — company, tax (GSTIN/PAN) and bank details.
  New vendors start as *pending verification*; procurement or finance verify them
  from the staff Vendors page (which activates the vendor) or reject the registration.
- Unverified vendors can sign in, track their status, and maintain their profile,
  but cannot submit invoices until verified.
- Verified vendors see POs sent to them, submit invoices against a PO with an
  optional attachment (PDF/PNG/JPG, max 5 MB), and track invoice approval,
  matching, and payments.
- Vendor accounts are separate from staff accounts (`vendor_users` table); vendor
  tokens cannot call staff APIs and vice versa. Attachment downloads are
  restricted to staff and the owning vendor.

## API

Staff endpoints under `/api`, JSON, `Authorization: Bearer <staff token>`:

- `POST /auth/login` (returns `totp_required` + temp token when 2FA is on), `POST /auth/totp/verify`
- `POST /auth/totp/setup|enable|disable` — two-factor enrolment/removal
- `GET /auth/me`, `POST /auth/change-password`
- `GET|POST /users`, `PUT /users/:id` (admin)
- `GET|POST /vendors`, `PUT /vendors/:id`, `POST /vendors/:id/verify|reject-verification`
- `GET|POST /vendors/:id/tds-certificates`, `PUT /vendors/:id/tds-certificates/:certId`, `GET .../:certId/file`
- `GET|POST /prs`, `GET /prs/:id`, `POST /prs/:id/approve|reject`
- `GET|POST /pos`, `GET /pos/:id`, `POST /pos/:id/status`
- `GET|POST /grns`, `GET /grns/:id`, `POST /grns/:id/approve|reject`
- `GET|POST /invoices`, `GET /invoices/:id`, `POST /invoices/:id/approve|reject`
- `GET /invoices/:id/attachment` (token via header or `?token=`)
- `GET|POST /payments`
- `GET /dashboard`
- `GET /meta/tax` — GSTINs, TDS sections, RCM categories, GL reference masters, GST states, custom field labels for forms
- `GET|POST /settings/gstins|tds-sections|rcm-categories`, `PUT .../:id` (admin)
- `GET|POST /settings/ap-account-codes|sub-locations|cost-centres`, `PUT .../:id` (admin)
- `GET|PUT /settings/custom-field-labels` (admin)
- `GET /journal`, `GET /journal/export?format=csv|xlsx`
- `GET /vendors/:id/statement[?format=csv]`
- `GET /tax/summary`, `POST /tax/deposits`
- `POST /gst/gstr2b/import` (multipart CSV), `GET /gst/recon?company_gstin_id&period`

Vendor portal endpoints (vendor token):

- `POST /vendor/register` (public), `POST /vendor/login` (public)
- `GET /vendor/me`, `PUT /vendor/profile`
- `GET /vendor/pos`
- `GET /vendor/invoices`, `POST /vendor/invoices` (multipart, optional `attachment`)
