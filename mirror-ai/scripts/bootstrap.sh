#!/usr/bin/env bash
# Install or refresh Mirror AI from the skill's bundled app/ into ~/.mirror-ai
set -euo pipefail
SKILL_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
INSTALL="${MIRROR_AI_HOME:-$HOME/.mirror-ai}"
BUNDLE="$SKILL_ROOT/app"

if [ ! -f "$BUNDLE/package.json" ]; then
  echo "ERROR: This skill is missing app/ — reinstall with: npx skills add paytm/mirror-ai-skills@mirror-ai -g -y"
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: Node.js is required (22+). Install from https://nodejs.org/"
  exit 1
fi

NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "ERROR: Node.js 22+ required (found $(node -v))."
  exit 1
fi

mkdir -p "$INSTALL"
rsync -a --delete \
  --exclude 'node_modules/' \
  --exclude '.cache/' \
  --exclude 'generated reports/' \
  --exclude '.env' \
  "$BUNDLE/" "$INSTALL/"

cd "$INSTALL"
chmod +x setup.sh scripts/*.sh 2>/dev/null || true

if [ ! -d node_modules ]; then
  echo "Running first-time setup (npm install)…"
  npm install --no-fund --no-audit
fi
mkdir -p .cache/repos "generated reports"
if [ ! -f .env ] && [ -f .env.example ]; then
  cp .env.example .env
fi

echo "$INSTALL"
