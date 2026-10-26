#!/usr/bin/env bash
# Bundle the Mirror AI app inside the marketplace skill (skills/mirror-ai/app/).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$ROOT/skills/mirror-ai/app"

rm -rf "$DEST"
mkdir -p "$DEST"

rsync -a \
  --exclude '.DS_Store' \
  --exclude 'node_modules/' \
  --exclude '.cache/' \
  --exclude 'repos/' \
  --exclude 'generated reports/' \
  --exclude '.git/' \
  --exclude 'skills/' \
  --exclude 'distribution/' \
  --exclude '.claude-flow/' \
  --exclude '.swarm/' \
  --exclude '.probe/' \
  --exclude 'ruvector.db' \
  --exclude 'agentdb.rvf' \
  --exclude 'agentdb.rvf.lock' \
  --exclude 'tests/.npx.log' \
  --exclude 'tests/.claude-args.log' \
  --exclude 'tests/.cli-report.md' \
  --exclude 'reports/fixture-comparison.stub.md' \
  --exclude '.env' \
  "$ROOT/" "$DEST/"

chmod +x "$DEST/setup.sh" "$DEST/scripts/"*.sh 2>/dev/null || true
chmod +x "$ROOT/skills/mirror-ai/scripts/"*.sh 2>/dev/null || true

echo "Skill app bundle: $DEST ($(du -sh "$DEST" | awk '{print $1}'))"
echo "Commit and push skills/ repo: cd skills && git add -A && git commit && git push"
echo "New org remote (first time): ./scripts/publish-skill-repo.sh"
