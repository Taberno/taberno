#!/usr/bin/env bash
#
# First-time setup for a Taberno deployment.
# Run ONCE, from the repo root, on your server:  ./scripts/setup.sh
#
set -euo pipefail
cd "$(dirname "$0")/.."

echo "▶ Taberno setup"

# 1. Node present and recent enough (native modules compile against it) ────────
if ! command -v node >/dev/null 2>&1; then
  echo "✗ Node.js not found. Install Node 22 LTS first:"
  echo "  https://github.com/nodesource/distributions"
  exit 1
fi
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "✗ Node $(node -v) is too old — install Node 22 LTS."
  exit 1
fi
echo "✓ Node $(node -v)"

# 2. Dependencies — compiled here, for THIS machine (never copy node_modules) ──
echo "▶ Installing dependencies…"
npm ci

# 3. .env — created with production-safe defaults and a real secret ───────────
if [ ! -f .env ]; then
  echo "▶ Creating .env from .env.example…"
  cp .env.example .env
  SECRET=$(openssl rand -hex 32)
  awk -v s="$SECRET" '
    /^SESSION_SECRET=/ { print "SESSION_SECRET=" s; next }
    /^NODE_ENV=/       { print "NODE_ENV=production";  next }
    /^HOST=/           { print "HOST=127.0.0.1";       next }
    { print }
  ' .env > .env.tmp && mv .env.tmp .env
  echo "✓ .env created (generated SESSION_SECRET, NODE_ENV=production, HOST=127.0.0.1)"
  echo "  → Set your Stripe/PayPal keys in .env if you use env vars for them."
else
  echo "✓ .env already exists — leaving it untouched"
fi

# 4. Runtime data directories (gitignored; hold the DB, uploads, backups) ──────
mkdir -p data uploads backups
echo "✓ data/ uploads/ backups/ ready"

# 5. Build (compiles TS to dist/ and copies migrations) ───────────────────────
echo "▶ Building…"
npm run build
echo "✓ Build complete"

cat <<'NEXT'

────────────────────────────────────────────────────────────────────────
Setup done. Next:

  1. Install the service (once):
       sudo cp deploy/taberno.service /etc/systemd/system/taberno.service
       sudo nano /etc/systemd/system/taberno.service   # set User, WorkingDirectory, node path
       sudo systemctl daemon-reload
       sudo systemctl enable --now taberno

  2. Check it's up:
       systemctl status taberno
       curl -s localhost:3000/health

  3. Open the site and visit /admin to create your first admin account,
     then set store URL, email (SMTP) and payment keys in Settings.

  See DEPLOY.md for TLS (Caddy), updates, and backups.
────────────────────────────────────────────────────────────────────────
NEXT
