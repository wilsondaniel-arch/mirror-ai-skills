#!/usr/bin/env bash
# Mirror AI setup diagnostics — safe to run; never prints secret values.
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PASS=0
WARN=0
FAIL=0

ok() { echo "PASS  $*"; PASS=$((PASS + 1)); }
warn() { echo "WARN  $*"; WARN=$((WARN + 1)); }
fail() { echo "FAIL  $*"; FAIL=$((FAIL + 1)); }

PORT=4173
if [[ -f "$ROOT/.env" ]]; then
  line="$(grep -E '^PORT=' "$ROOT/.env" 2>/dev/null | tail -1 || true)"
  [[ -n "$line" ]] && PORT="${line#PORT=}"
fi
URL="http://127.0.0.1:${PORT}/"

echo "Mirror AI diagnose — $ROOT"
echo ""

# Project layout
if [[ -f "$ROOT/package.json" ]] && grep -q '"name": "mirror-ai"' "$ROOT/package.json" 2>/dev/null; then
  ok "package.json (mirror-ai)"
else
  fail "Not the Mirror AI project root (missing package.json name mirror-ai)"
fi

for dir in src public prompts; do
  if [[ -d "$ROOT/$dir" ]]; then ok "directory $dir/"; else fail "missing $dir/"; fi
done

# Node
if command -v node >/dev/null 2>&1; then
  major="$(node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo 0)"
  ver="$(node -v)"
  if [[ "$major" -ge 22 ]]; then ok "Node $ver"; else fail "Node $ver — need v22+"; fi
else
  fail "Node.js not installed"
fi

if command -v npm >/dev/null 2>&1; then ok "npm $(npm -v)"; else fail "npm not found"; fi

if command -v git >/dev/null 2>&1; then ok "git installed"; else warn "git missing — remote repo URLs will not clone"; fi

# Dependencies
if [[ -d "$ROOT/node_modules" ]]; then ok "node_modules present"; else fail "node_modules missing — run: npm install"; fi

# Env (presence only)
if [[ -f "$ROOT/.env" ]]; then
  ok ".env exists"
  if grep -qE '^ANTHROPIC_API_KEY=.+$' "$ROOT/.env" 2>/dev/null; then ok "ANTHROPIC_API_KEY is set"; else warn "ANTHROPIC_API_KEY not set — needed if claude CLI absent"; fi
  if grep -qE '^BITBUCKET_TOKEN=.+$' "$ROOT/.env" 2>/dev/null || grep -qE '^BITBUCKET_APP_PASSWORD=.+$' "$ROOT/.env" 2>/dev/null; then
    ok "Bitbucket credentials present in .env"
  else
    warn "No Bitbucket token in .env — private Bitbucket clones may fail"
  fi
else
  warn ".env missing — run ./setup.sh or cp .env.example .env"
fi

# Audit runner
if command -v agent >/dev/null 2>&1 && agent --version >/dev/null 2>&1; then
  if agent status 2>&1 | grep -qi "not logged in"; then
    warn "Cursor Agent CLI installed but not signed in — run: agent login"
  else
    ok "Cursor Agent CLI ready (preferred in Cursor)"
  fi
fi
if command -v claude >/dev/null 2>&1 && claude --version >/dev/null 2>&1; then
  ok "Claude Code CLI available"
elif [[ -f "$ROOT/.env" ]] && grep -qE '^ANTHROPIC_API_KEY=.+$' "$ROOT/.env" 2>/dev/null; then
  ok "API runner possible (ANTHROPIC_API_KEY set)"
else
  warn "No agent login, claude CLI, or API key — run ./setup.sh --yes or agent login"
fi

# Server
if curl -sf -o /dev/null --max-time 2 "$URL" 2>/dev/null; then
  ok "HTTP server responding at $URL"
else
  warn "Server not up at $URL — run: ./scripts/start-ui.sh"
fi

if [[ -f "$ROOT/.cache/mirror-ai-serve.log" ]]; then
  echo ""
  echo "--- last lines of .cache/mirror-ai-serve.log ---"
  tail -8 "$ROOT/.cache/mirror-ai-serve.log" 2>/dev/null || true
fi

echo ""
echo "Summary: $PASS passed, $WARN warnings, $FAIL failures"
if [[ "$FAIL" -gt 0 ]]; then
  echo "Next: fix the first FAIL line above, then run ./setup.sh or npm install && npm test"
  exit 1
fi
exit 0
