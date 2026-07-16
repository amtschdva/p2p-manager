# P2P Manager — monorepo

Two builds of the same procure-to-pay application, kept in sync feature by
feature:

| Directory | Build | Port | Database |
|---|---|---|---|
| [`p2p-app/`](p2p-app/) | **Classic** — monolithic `server.js`, every feature always on | 9138 | `p2p` |
| [`p2p-app-modular/`](p2p-app-modular/) | **Modular** — route-split, features license-gated via the `MODULES` env var (`tax`, `payments`, `vendor_portal`) | 9139 | `p2p_mod` |

Each app has its own README with full feature/deployment documentation.

## Convention

New features are built and test-verified in **`p2p-app-modular` first**, then
ported to **`p2p-app`** with module gating stripped (everything always on in
classic). A cross-app feature should land as a single commit touching both
directories, so the two builds never silently drift.

## Drift check

`tools/check-drift.sh` enforces that the two builds stay in lockstep. It
verifies that the shared modules (`journal.js`, `approvals.js`, `seed.js`,
`gst-states.js`, the CSS/HTML) are byte-identical, that the API route
inventories match exactly, that the two SPAs differ only in the
module-gating scaffolding, that every test exists in both suites (except the
modular-only gating test), and that the schemas differ only by the planned
inventory-module tables. Intentional differences are allowlisted in the
script itself, each with a reason.

It runs automatically as a pre-commit hook. **Enable it once per clone:**

```bash
git config core.hooksPath tools/githooks
```

## Development

Both apps expect the shared Postgres 16 container (`p2p-postgres`, host port
5433). From either app directory:

```bash
npm install
npm run seed     # reset + demo data
npm start        # classic :9138 / modular :9139
npm test         # end-to-end suite against a dedicated *_test database
```

Run `npm test` in **both** apps before committing anything that touches
shared behaviour.
