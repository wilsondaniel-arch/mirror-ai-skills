#!/usr/bin/env bash
# Install or refresh Mirror AI from the skill's bundled app/ into ~/.mirror-ai
set -euo pipefail
SKILL_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
INSTALL="${MIRROR_AI_HOME:-$HOME/.mirror-ai}"
BUNDLE="$SKILL_ROOT/app"

if [ ! -f "$BUNDLE/package.json" ]; then
  echo "ERROR: This skill is missing app/ — reinstall with: npx skills add wilsondaniel-arch/mirror-ai-skills@mirror-ai -g -y"
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
if command -v rsync >/dev/null 2>&1; then
  rsync -a --delete \
    --exclude 'node_modules/' \
    --exclude '.cache/' \
    --exclude 'generated reports/' \
    --exclude '.env' \
    "$BUNDLE/" "$INSTALL/"
else
  # Minimal images (CI, Ark pipeline boxes) often lack rsync; tar is always there.
  # Clear the old app files first so removed files do not linger (same as --delete),
  # keeping installed packages, caches, saved reports and local settings.
  for entry in "$INSTALL"/* "$INSTALL"/.[!.]*; do
    [ -e "$entry" ] || continue
    case "$(basename "$entry")" in
      node_modules | .cache | 'generated reports' | .env | .tools) ;;
      *) rm -rf "$entry" ;;
    esac
  done
  (cd "$BUNDLE" && tar cf - \
    --exclude './node_modules' --exclude './.cache' --exclude './generated reports' --exclude './.env' .) \
    | (cd "$INSTALL" && tar xf -)
fi

cd "$INSTALL"
chmod +x setup.sh scripts/*.sh 2>/dev/null || true
./setup.sh --yes --skip-tests
echo "$INSTALL"
