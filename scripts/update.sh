#!/usr/bin/env bash
#
# Update a running Taberno deployment. Run from anywhere on the server:
#
#   ./scripts/update.sh            Deploy the latest commit on the current branch
#   ./scripts/update.sh v1.2.0     Deploy a specific tag/commit — also how you ROLL BACK
#
# Your store data (data/, uploads/, uploaded themes, .env) is gitignored, so
# nothing here can touch it.
#
set -euo pipefail
cd "$(dirname "$0")/.."

REF="${1:-}"

echo "▶ Fetching…"
git fetch --all --tags --prune

if [ -n "$REF" ]; then
  echo "▶ Checking out $REF…"
  git checkout "$REF"
else
  # --ff-only refuses to deploy if local commits diverged, rather than merging
  # blindly — keeps the server a clean mirror of the branch.
  echo "▶ Pulling latest…"
  git pull --ff-only
fi

echo "▶ Installing dependencies…"
npm ci

echo "▶ Building…"
npm run build

echo "▶ Restarting service…"
sudo systemctl restart taberno

sleep 1
echo "✓ Deployed $(git describe --tags --always)"
systemctl --no-pager --lines=0 status taberno || true
