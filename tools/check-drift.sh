#!/usr/bin/env bash
# Drift check between the classic (p2p-app) and modular (p2p-app-modular)
# builds. The two apps are maintained in lockstep — this script fails when
# they diverge anywhere other than the small, deliberate differences listed
# below (module-gating scaffolding, the inventory-module schema, the default
# dev port). Run from anywhere: tools/check-drift.sh
#
# Wired as a pre-commit hook via:  git config core.hooksPath tools/githooks
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLASSIC="$ROOT/p2p-app"
MODULAR="$ROOT/p2p-app-modular"
FAIL=0

fail() { echo "DRIFT: $1"; FAIL=1; }

# ---------- 1. files that must be byte-identical ----------
IDENTICAL_FILES=(
  src/journal.js
  src/lib/gst-states.js
  src/approvals.js
  src/seed.js
  public/css/styles.css
  public/index.html
  public/vendor.html
)
for f in "${IDENTICAL_FILES[@]}"; do
  if ! diff -q "$CLASSIC/$f" "$MODULAR/$f" >/dev/null 2>&1; then
    fail "$f differs between the apps (must be byte-identical)"
    diff "$CLASSIC/$f" "$MODULAR/$f" | head -10
  fi
done

# ---------- 2. mailer.js — identical apart from the default dev port ----------
if ! diff <(sed 's/localhost:9138/localhost:PORT/' "$CLASSIC/src/mailer.js") \
          <(sed 's/localhost:9139/localhost:PORT/' "$MODULAR/src/mailer.js") >/dev/null; then
  fail "src/mailer.js differs beyond the known 9138/9139 default-port line"
fi

# ---------- 3. API route inventory must match exactly ----------
routes() { grep -hoE "app\.(get|post|put|delete)\('[^']+'" "$@" 2>/dev/null | sed "s/app\.//; s/('/ /" | sort -u; }
if ! diff <(routes "$CLASSIC/src/server.js") \
          <(routes "$MODULAR"/src/routes/*.js "$MODULAR/src/app-base.js" "$MODULAR/src/server.js") > /tmp/p2p-route-drift.txt; then
  fail "API route inventories differ:"
  cat /tmp/p2p-route-drift.txt
fi

# ---------- 4. frontends — identical after stripping module scaffolding ----------
# The only allowed difference is the licensed-modules plumbing (classic stubs
# has() to always-true). Everything else in the two SPAs must match.
GATING='MODULES|p2p_modules|setModules\(|const has = |license-gated modules|licensed modules|let ME = null;|Array\.isArray\(list\)|^}$'
for f in public/js/app.js public/js/vendor.js; do
  if ! diff <(grep -vE "$GATING" "$CLASSIC/$f") <(grep -vE "$GATING" "$MODULAR/$f") > /tmp/p2p-fe-drift.txt; then
    fail "$f differs beyond the module-gating scaffolding:"
    head -20 /tmp/p2p-fe-drift.txt
  fi
done

# ---------- 5. every modular test must exist in classic (except modular-only) ----------
MODULAR_ONLY_TESTS=(
  "module gating: a core-only server hides tax, payments and vendor portal"
)
titles() { grep -hoE "^test\('[^']+'" "$1" | sed "s/^test('//; s/'\$//"; }
while IFS= read -r t; do
  skip=0
  for allow in "${MODULAR_ONLY_TESTS[@]}"; do [ "$t" = "$allow" ] && skip=1; done
  [ "$skip" = 1 ] && continue
  if ! grep -qF "test('$t'" "$CLASSIC/tests/api.test.js"; then
    fail "test missing from classic suite: $t"
  fi
done < <(titles "$MODULAR/tests/api.test.js")
while IFS= read -r t; do
  if ! grep -qF "test('$t'" "$MODULAR/tests/api.test.js"; then
    fail "test missing from modular suite: $t"
  fi
done < <(titles "$CLASSIC/tests/api.test.js")

# ---------- 6. schema tables — classic == modular minus the inventory module ----------
MODULAR_ONLY_TABLES=(items warehouses stock_ledger)
tables() { grep -hoE "CREATE TABLE IF NOT EXISTS \w+" "$1" | awk '{print $6}' | sort -u; }
while IFS= read -r t; do
  skip=0
  for allow in "${MODULAR_ONLY_TABLES[@]}"; do [ "$t" = "$allow" ] && skip=1; done
  [ "$skip" = 1 ] && continue
  if ! grep -q "CREATE TABLE IF NOT EXISTS $t\b" "$CLASSIC/src/db.js"; then
    fail "table missing from classic schema: $t"
  fi
done < <(tables "$MODULAR/src/db.js")
while IFS= read -r t; do
  if ! grep -q "CREATE TABLE IF NOT EXISTS $t\b" "$MODULAR/src/db.js"; then
    fail "table missing from modular schema: $t"
  fi
done < <(tables "$CLASSIC/src/db.js")

if [ "$FAIL" = 0 ]; then
  echo "drift check OK — classic and modular builds are in sync"
else
  echo ""
  echo "Drift detected. Either port the change to the other app, or — if the"
  echo "difference is genuinely intentional — add it to the allowlists in"
  echo "tools/check-drift.sh with a comment explaining why."
  exit 1
fi
