#!/usr/bin/env bash
# Setup completo do ambiente local: reset D1 → superadmin → demo → smoke.
# Requer: npm install.  Uso: bash scripts/dev-setup.sh
set -e
cd "$(dirname "$0")/.."
npx wrangler d1 migrations apply tigu-db --local
SUPER_PW="${TIGU_SUPER_PASSWORD:-TiguSuper!Dev2026}"
node scripts/create-super.mjs --email super@tigu.app --password "$SUPER_PW"
echo "▶ subindo wrangler dev em :8787…"
npx wrangler dev --port 8787 --ip 127.0.0.1 >/tmp/tigu-wrangler.log 2>&1 &
WR=$!
trap 'kill $WR 2>/dev/null || true' EXIT
for i in $(seq 1 40); do curl -sf http://127.0.0.1:8787/api/health >/dev/null 2>&1 && break; sleep 1; done
TIGU_SUPER_PASSWORD="$SUPER_PW" node scripts/setup-demo.mjs
TIGU_SUPER_PASSWORD="$SUPER_PW" node scripts/smoke.mjs
