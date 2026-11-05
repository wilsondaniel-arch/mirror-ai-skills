#!/usr/bin/env bash
# Runs Mirror AI for an automated pipeline (the Ark flow
# telco-apps-mirror-audit-report) and leaves the same report the local tool
# makes — Markdown, HTML and PDF — in an output folder.
#
#   ark-audit.sh index <android_repo> <ios_repo> [out_dir]   -> modules-index.json
#   ark-audit.sh audit <android_repo> <ios_repo> [out_dir]   -> parity-report.{md,html,pdf}
#
# Environment (all optional):
#   MIRROR_AI_BRANCH                  branch for both repos (checked out before reading)
#   MIRROR_AI_ANDROID_BRANCH / _IOS_BRANCH   per-platform override
#   MIRROR_AI_MODULE / MIRROR_AI_MODULES     module ids or labels, comma or space separated
#   MIRROR_AI_COMMON=1                 every module both apps declare
#   (none of the three)                every module (whole project)
#   MIRROR_AI_MARKET                   recorded in the run log; the audit reads the market from code
#   ANTHROPIC_API_KEY                  Batch API with a hard dollar cap (MIRROR_AI_BUDGET_USD, default 5);
#                                      without it the signed-in `claude` CLI is used (subscription usage)
set -euo pipefail

MODE="${1:-}"
if [ "$MODE" != "index" ] && [ "$MODE" != "audit" ]; then
  echo "usage: $0 index|audit <android_repo> <ios_repo> [out_dir]" >&2
  exit 2
fi
[ $# -ge 3 ] || { echo "usage: $0 $MODE <android_repo> <ios_repo> [out_dir]" >&2; exit 2; }

APP="$(cd "$(dirname "$0")/.." && pwd)"
ANDROID="$(cd "$2" && pwd)"
IOS="$(cd "$3" && pwd)"
OUT="${4:-$PWD}"
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"

checkout() {
  local repo="$1" branch="$2"
  [ -n "$branch" ] || return 0
  [ -d "$repo/.git" ] || { echo "note: $repo is not a git checkout; using it as it is" >&2; return 0; }
  git -C "$repo" fetch --quiet origin "$branch" 2>/dev/null || true
  git -C "$repo" checkout --quiet "$branch" 2>/dev/null || git -C "$repo" checkout --quiet -B "$branch" "origin/$branch"
  echo "$(basename "$repo"): $(git -C "$repo" rev-parse --abbrev-ref HEAD) @ $(git -C "$repo" rev-parse --short HEAD)" >&2
}
checkout "$ANDROID" "${MIRROR_AI_ANDROID_BRANCH:-${MIRROR_AI_BRANCH:-}}"
checkout "$IOS" "${MIRROR_AI_IOS_BRANCH:-${MIRROR_AI_BRANCH:-}}"

cd "$APP"
[ -d node_modules ] || npm ci --silent --no-audit --no-fund
export NODE_NO_WARNINGS=1

if [ "$MODE" = "index" ]; then
  npm run audit --silent -- --android "$ANDROID" --ios "$IOS" --list --json > "$OUT/modules-index.json"
  echo "Wrote $OUT/modules-index.json" >&2
  exit 0
fi

export MIRROR_AI_RUNNER=budget
# The settings the local reports are made with, so a pipeline run reads the
# same code with the same models and produces the same report. Any of them can
# still be overridden by the pipeline's own environment or secrets.
export MIRROR_AI_BUDGET_USD="${MIRROR_AI_BUDGET_USD:-5}"
export MIRROR_AI_SCAN_MODEL="${MIRROR_AI_SCAN_MODEL:-claude-haiku-5-5}"
export MIRROR_AI_VERIFY_MODEL="${MIRROR_AI_VERIFY_MODEL:-claude-sonnet-5-5}"
export MIRROR_AI_SCAN_CHUNKS="${MIRROR_AI_SCAN_CHUNKS:-8}"
export MIRROR_AI_VERIFY_SNIPPET_TOKENS="${MIRROR_AI_VERIFY_SNIPPET_TOKENS:-40000}"

# Model access: a Console key uses the Batch API; otherwise the `claude` CLI
# runs on the subscription login (CLAUDE_CODE_OAUTH_TOKEN on a pipeline box).
# Install the CLI into the app folder if this box does not have it.
TOOLS="$APP/.tools"
if [ -z "${ANTHROPIC_API_KEY:-}" ] && ! command -v claude >/dev/null 2>&1; then
  if [ ! -x "$TOOLS/claude/node_modules/.bin/claude" ]; then
    echo "Installing the claude CLI into $TOOLS/claude" >&2
    npm install --silent --no-audit --no-fund --prefix "$TOOLS/claude" @anthropic-ai/claude-code >&2
  fi
  export PATH="$TOOLS/claude/node_modules/.bin:$PATH"
fi
if [ -z "${ANTHROPIC_API_KEY:-}" ] && [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ] && ! claude auth status >/dev/null 2>&1; then
  echo "warning: no ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN, and the claude CLI is not signed in; the audit will fail to reach Claude." >&2
fi

# PDF: print with any installed Chrome/Chromium; on a box without one, fetch a
# headless Chrome into the app folder. Without it the report is still md+html.
if [ -z "${MIRROR_AI_CHROME:-}" ] && [ "$(uname -s)" != "Darwin" ] \
  && ! command -v google-chrome >/dev/null 2>&1 && ! command -v google-chrome-stable >/dev/null 2>&1 \
  && ! command -v chromium >/dev/null 2>&1 && ! command -v chromium-browser >/dev/null 2>&1; then
  CHROME_BIN="$(ls -d "$TOOLS"/chrome/chrome-headless-shell/*/*/chrome-headless-shell 2>/dev/null | head -1 || true)"
  if [ -z "$CHROME_BIN" ]; then
    echo "Fetching a headless Chrome for the PDF into $TOOLS/chrome" >&2
    npx -y @puppeteer/browsers install chrome-headless-shell@stable --path "$TOOLS/chrome" >&2 || true
    CHROME_BIN="$(ls -d "$TOOLS"/chrome/chrome-headless-shell/*/*/chrome-headless-shell 2>/dev/null | head -1 || true)"
  fi
  [ -n "$CHROME_BIN" ] && export MIRROR_AI_CHROME="$CHROME_BIN"
fi

SELECT=()
WANTED="${MIRROR_AI_MODULES:-${MIRROR_AI_MODULE:-}}"
# MIRROR_AI_SHARD=i/n audits every n-th module starting at the i-th (whole-project
# order), so a long audit can run as n short pipeline sessions and be merged.
if [ -z "$WANTED" ] && [ -n "${MIRROR_AI_SHARD:-}" ]; then
  WANTED="$(npm run audit --silent -- --android "$ANDROID" --ios "$IOS" --list --json 2>/dev/null \
    | MIRROR_AI_SHARD="$MIRROR_AI_SHARD" node -e '
      const index = JSON.parse(require("fs").readFileSync(0, "utf8"));
      const [i, n] = process.env.MIRROR_AI_SHARD.split("/").map(Number);
      const rows = [...index.common, ...index.androidOnly, ...index.iosOnly];
      console.log(rows.filter((_, at) => at % n === i - 1).map((row) => row.key).join(" "));')"
  [ -n "$WANTED" ] || { echo "MIRROR_AI_SHARD=$MIRROR_AI_SHARD selected no modules" >&2; exit 1; }
fi
if [ -n "$WANTED" ]; then
  for module in ${WANTED//,/ }; do SELECT+=(--module "$module"); done
elif [ -n "${MIRROR_AI_COMMON:-}" ] && [ "${MIRROR_AI_COMMON}" != "0" ] && [ "${MIRROR_AI_COMMON}" != "false" ]; then
  SELECT=(--common)
else
  SELECT=(--all)
fi

LOG="$OUT/mirror-ai-run.log"
{
  echo "settings: scan ${MIRROR_AI_SCAN_MODEL} x${MIRROR_AI_SCAN_CHUNKS} chunks, verify ${MIRROR_AI_VERIFY_MODEL} ${MIRROR_AI_VERIFY_SNIPPET_TOKENS} snippet tokens, cap \$${MIRROR_AI_BUDGET_USD}, transport $([ -n "${ANTHROPIC_API_KEY:-}" ] && echo batch || echo claude-cli)"
  echo "market: ${MIRROR_AI_MARKET:-unset}"
  echo "android: $ANDROID"
  echo "ios: $IOS"
  echo "selection: ${SELECT[*]}"
} > "$LOG"

# A pipeline can drop an action that prints nothing for minutes (the scan only
# reports every 10 requests), so say we are alive every 30 seconds.
( while sleep 30; do echo "[mirror-ai] $(date -u +%H:%M:%S) audit running" >&2; done ) &
HEARTBEAT=$!
trap 'kill "$HEARTBEAT" 2>/dev/null || true' EXIT

# The report is written by the tool, not by an agent, so it matches a local run exactly.
npm run audit --silent -- --android "$ANDROID" --ios "$IOS" "${SELECT[@]}" --out "$OUT/parity-report.md" 2>&1 | tee -a "$LOG" >&2

# The CLI also saved .md/.html/.pdf in "generated reports/<project>/"; copy the HTML and PDF next to the Markdown.
SAVED="$(grep -o 'Saved in "[^"]*": [^,]*\.md' "$LOG" | tail -1 || true)"
if [ -n "$SAVED" ]; then
  FOLDER="$(printf '%s' "$SAVED" | sed -E 's/^Saved in "([^"]*)": .*/\1/')"
  NAME="$(printf '%s' "$SAVED" | sed -E 's/.*: ([^ ]*)\.md$/\1/')"
  for ext in html pdf; do
    if [ -f "$APP/$FOLDER/$NAME.$ext" ]; then cp "$APP/$FOLDER/$NAME.$ext" "$OUT/parity-report.$ext"; fi
  done
fi

echo "Report: $OUT/parity-report.md" >&2
[ -f "$OUT/parity-report.html" ] && echo "HTML:   $OUT/parity-report.html" >&2
[ -f "$OUT/parity-report.pdf" ] && echo "PDF:    $OUT/parity-report.pdf" >&2 || echo "PDF:    not produced (Chrome is needed to print it)" >&2
grep -E "Budget:|API-equivalent usage" "$LOG" | tail -1 >&2 || true
