#!/usr/bin/env bash
# Runs Mirror AI for an automated pipeline (the Ark flow
# telco-apps-mirror-audit-report) and leaves the same report the local tool
# makes — Markdown, HTML and PDF — in an output folder.
#
#   ark-audit.sh index <android_repo> <ios_repo> [out_dir]   -> modules-index.json
#   ark-audit.sh audit <android_repo> <ios_repo> [out_dir]   -> parity-report.{md,html,pdf}, summary.json, run.json
#
# Environment (all optional):
#   MIRROR_AI_BRANCH                  branch for both repos (checked out before reading)
#   MIRROR_AI_ANDROID_BRANCH / _IOS_BRANCH   per-platform override
#   MIRROR_AI_MODULE / MIRROR_AI_MODULES     module ids or labels, comma or space separated;
#                                      the report holds only those modules
#   MIRROR_AI_COMMON=1                 every module both apps declare
#   (none of the three)                whole project: every common module, then a last
#                                      Miscellaneous section (platform-only modules, modules
#                                      missing from the enum, code that belongs to no module)
#   <out_dir>/audit-scope.txt          read when none of the three is set (an Ark flow writes it
#                                      from its inputs): "project", "common", or module names
#                                      (override the path with MIRROR_AI_SCOPE_FILE)
#   MIRROR_AI_SECURITY=1               add the opt-in security skill: a Security Analysis section per
#                                      module and one App-wide Security section (off by default)
#   <out_dir>/audit-skills.txt         read when MIRROR_AI_SECURITY is unset: a line "security" turns it
#                                      on (an Ark flow writes it; override the path with MIRROR_AI_SKILLS_FILE)
#   MIRROR_AI_RULES_REPO / _REF / _PATH   where the security pass reads its rules knowledge base
#                                      (default: superapp-workspace mirror-ai-reports, docs/security-rules.md; the
#                                      bundled prompts/references/security-rules.md when unreachable)
#   MIRROR_AI_SECURITY_RULES           a rules file to use instead (skips the fetch)
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

# A pipeline's actions cannot take run inputs, so an earlier stage may leave
# the choice in a file: "project" (or empty), "common", or module names.
SCOPE_FILE="${MIRROR_AI_SCOPE_FILE:-$OUT/audit-scope.txt}"
if [ -z "${MIRROR_AI_MODULES:-}${MIRROR_AI_MODULE:-}" ] && [ -z "${MIRROR_AI_COMMON:-}" ] && [ -f "$SCOPE_FILE" ]; then
  SCOPE="$(tr -s ' ,\t\r\n' '  ' < "$SCOPE_FILE" | sed -E 's/^ +//; s/ +$//')"
  case "$(printf '%s' "$SCOPE" | tr '[:upper:]' '[:lower:]')" in
    ""|project|all|whole|whole-project|full-project) ;;
    common|all-common) MIRROR_AI_COMMON=1 ;;
    *) MIRROR_AI_MODULES="$SCOPE" ;;
  esac
  echo "scope from $SCOPE_FILE: ${SCOPE:-project}" >&2
fi

# Opt-in skills, the same way: a flow that wants the security section leaves
# "security" in audit-skills.txt. Without the file nothing changes.
SKILLS_FILE="${MIRROR_AI_SKILLS_FILE:-$OUT/audit-skills.txt}"
if [ -z "${MIRROR_AI_SECURITY:-}" ] && [ -f "$SKILLS_FILE" ] && grep -qiw "security" "$SKILLS_FILE"; then
  export MIRROR_AI_SECURITY=1
fi
if [ -n "${MIRROR_AI_SECURITY:-}" ]; then
  export MIRROR_AI_SECURITY
  echo "security skill: ${MIRROR_AI_SECURITY}" >&2
fi

SELECT=()
WANTED="${MIRROR_AI_MODULES:-${MIRROR_AI_MODULE:-}}"

# Completing an earlier run: when the output folder already holds a report of
# these same commits (a restarted stage keeps the files of its last attempt)
# and some of its modules could not be produced (a usage limit, a timeout),
# redo only those modules and merge them into it. MIRROR_AI_FRESH=1 opts out.
PREVIOUS_SCOPE=""
if [ -z "${MIRROR_AI_FRESH:-}" ] && [ -f "$OUT/parity-report.md" ] && [ -f "$OUT/run.json" ]; then
  SAME_CODE="$(ANDROID_HEAD="$(git -C "$ANDROID" rev-parse HEAD 2>/dev/null || true)" IOS_HEAD="$(git -C "$IOS" rev-parse HEAD 2>/dev/null || true)" node -e '
    const run = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const same = run.android?.commit && run.android.commit === process.env.ANDROID_HEAD && run.ios?.commit === process.env.IOS_HEAD;
    console.log(same ? [run.scope, ...(run.modules ?? [])].join(" ") : "");' "$OUT/run.json" 2>/dev/null || true)"
  if [ -n "$SAME_CODE" ]; then
    REDO="$(node --experimental-strip-types src/merge-report.ts --incomplete "$OUT" 2>/dev/null || true)"
    if [ -n "$REDO" ]; then
      PREVIOUS_SCOPE="$SAME_CODE"
      WANTED="$REDO"
      echo "completing the earlier report of these commits: redoing $REDO" >&2
    else
      echo "the earlier report of these commits is complete; rerunning in full" >&2
    fi
  fi
fi
# MIRROR_AI_SHARD=i/n audits every n-th module starting at the i-th (whole-project
# order), so a long audit can run as n short pipeline sessions and be merged.
if [ -z "$WANTED" ] && [ -z "$PREVIOUS_SCOPE" ] && [ -n "${MIRROR_AI_SHARD:-}" ]; then
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
  echo "security skill: ${MIRROR_AI_SECURITY:-off}"
} > "$LOG"

# The security pass maps every finding to a rule of the knowledge base in
# superapp-workspace (docs/security-rules.md on the reports branch, mirror-ai-reports). It is fetched fresh each
# run, so a merged rule applies to the next audit without a tool release. The
# file and commit used are recorded in security-rules.source.txt, which publish
# puts next to the report. A file the audit's own parser finds no rule in is
# not used, so the recorded source is always the one the prompt got. When the workspace is unreachable the bundled copy is used.
fetch_security_rules() {
  [ -n "${MIRROR_AI_SECURITY:-}" ] || return 0
  if [ -n "${MIRROR_AI_SECURITY_RULES:-}" ]; then
    echo "security rules: ${MIRROR_AI_SECURITY_RULES_SOURCE:-$MIRROR_AI_SECURITY_RULES}" | tee -a "$LOG" >&2
    return 0
  fi
  local repo="${MIRROR_AI_RULES_REPO:-${MIRROR_AI_REPORTS_REPO:-git@bitbucket.org:paytmteam/superapp-workspace.git}}"
  local ref="${MIRROR_AI_RULES_REF:-${MIRROR_AI_REPORTS_BRANCH:-mirror-ai-reports}}" file="${MIRROR_AI_RULES_PATH:-docs/security-rules.md}" tmp sha
  tmp="$(mktemp -d)"
  local why=""
  if ! timeout 120 git clone --quiet --depth 1 --filter=blob:none --no-checkout -b "$ref" "$repo" "$tmp/r" 2>/dev/null; then
    why="superapp-workspace $ref not reachable"
  elif ! git -C "$tmp/r" show "HEAD:$file" > "$OUT/security-rules.md" 2>/dev/null; then
    why="$file not on superapp-workspace $ref"
  elif [ "$(cd "$APP" && node --experimental-strip-types src/security-rules.ts count "$OUT/security-rules.md" 2>/dev/null || echo 0)" = "0" ]; then
    why="$file on superapp-workspace $ref has no rules"
  fi
  if [ -z "$why" ]; then
    sha="$(git -C "$tmp/r" rev-parse --short HEAD)"
    MIRROR_AI_SECURITY_RULES_SOURCE="superapp-workspace $file @ $ref $sha"
  else
    cp "$APP/prompts/references/security-rules.md" "$OUT/security-rules.md"
    MIRROR_AI_SECURITY_RULES_SOURCE="bundled prompts/references/security-rules.md ($why)"
  fi
  rm -rf "$tmp"
  export MIRROR_AI_SECURITY_RULES="$OUT/security-rules.md" MIRROR_AI_SECURITY_RULES_SOURCE
  printf '%s\n' "$MIRROR_AI_SECURITY_RULES_SOURCE" > "$OUT/security-rules.source.txt"
  echo "security rules: $MIRROR_AI_SECURITY_RULES_SOURCE" | tee -a "$LOG" >&2
}
# Called directly, not in a pipe: a pipe would run it in a subshell and lose the exports.
fetch_security_rules || true

# A pipeline can drop an action that prints nothing for minutes (the scan only
# reports every 10 requests), so say we are alive every 30 seconds.
( while sleep 30; do echo "[mirror-ai] $(date -u +%H:%M:%S) audit running" >&2; done ) &
HEARTBEAT=$!
trap 'kill "$HEARTBEAT" 2>/dev/null || true' EXIT

# Report UI: parity-report.html (and .pdf) use the module-tile / tab design rendered from parity-report.md.
# Root causes no rule covered (Rule = NEW) become proposals for a person to review
# and merge into docs/security-rules.md; the audit never edits the rules itself.
write_rule_proposals() {
  [ -n "${MIRROR_AI_SECURITY:-}" ] && [ -f "$OUT/parity-report.md" ] || return 0
  local label=""
  [ -f "$OUT/run.json" ] && label="$(node -e 'process.stdout.write(String(require(process.argv[1]).folder||""))' "$OUT/run.json" 2>/dev/null || true)"
  rm -f "$OUT/proposed-security-rules.md"
  node --experimental-strip-types src/security-rules.ts proposals "$OUT/parity-report.md" "$OUT/proposed-security-rules.md" "$label" 2>&1 | tee -a "$LOG" >&2 \
    || echo "warning: proposed security rules not written" >&2
}

render_report_ui() {
  node --experimental-strip-types src/report-ui.ts "$OUT" --out "$OUT/parity-report.html" --md "$OUT/parity-report.ui.md" --pdf "$OUT/parity-report.pdf" 2>&1 | tee -a "$LOG" >&2 \
    || echo "warning: report UI not rendered; parity-report.html keeps the plain layout" >&2
}

# The report folder the publish step will use: <App>-<scope>-<date>, or -2, -3 when a
# report of another session already sits there today. Publish picks the same name
# (same rule, same branch), but the jira stage runs before publish and links to
# run.json's reportUrl, so the name is settled here. Best effort: never fails the audit.
reserve_report_folder() {
  local run="$OUT/run.json"
  [ -f "$run" ] || return 0
  local repo="${MIRROR_AI_REPORTS_REPO:-git@bitbucket.org:paytmteam/superapp-workspace.git}"
  local branch app folder sid tmp dest n
  branch="$(node -e 'process.stdout.write(String(require(process.argv[1]).branchRef||""))' "$run" 2>/dev/null)"
  app="$(node -e 'process.stdout.write(String(require(process.argv[1]).app||""))' "$run" 2>/dev/null)"
  folder="$(node -e 'process.stdout.write(String(require(process.argv[1]).folder||""))' "$run" 2>/dev/null)"
  sid="$(node -e 'process.stdout.write(String(require(process.argv[1]).sessionId||""))' "$run" 2>/dev/null)"
  [ -n "$branch" ] && [ -n "$app" ] && [ -n "$folder" ] || return 0
  # Strip an earlier -N so a rerun of this step starts from the base name.
  folder="$(printf '%s' "$folder" | sed -E 's/(-[0-9]{4}-[0-9]{2}-[0-9]{2})-[0-9]+$/\1/')"
  tmp="$(mktemp -d)"
  if ! timeout 120 git clone --quiet --depth 1 --filter=blob:none --no-checkout -b "$branch" "$repo" "$tmp/r" 2>/dev/null; then
    rm -rf "$tmp"; echo "report folder: $folder (reports branch not reachable; publish settles the name)" >&2; return 0
  fi
  dest="$folder"; n=2
  while git -C "$tmp/r" cat-file -e "HEAD:reports/$app/$dest/run.json" 2>/dev/null \
    && [ "$(git -C "$tmp/r" show "HEAD:reports/$app/$dest/run.json" 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(String(JSON.parse(s).sessionId||""))}catch{}})')" != "$sid" -o -z "$sid" ]; do
    dest="$folder-$n"; n=$((n + 1))
  done
  rm -rf "$tmp"
  node -e '
    const fs = require("fs"), [file, dest] = process.argv.slice(1);
    const r = JSON.parse(fs.readFileSync(file, "utf8"));
    if (r.folder !== dest) {
      for (const k of ["reportUrl", "reportMdUrl"]) if (r[k]) r[k] = r[k].replace("/" + r.folder + "/", "/" + dest + "/");
      r.folder = dest;
      fs.writeFileSync(file, JSON.stringify(r, null, 2) + "\n");
    }' "$run" "$dest" 2>/dev/null || true
  echo "report folder: $dest" >&2
}

# An audit where no module could be produced (a usage limit, an auth failure) is a
# failure, not a clean report: stop here so the flow files no empty ticket, and a
# restart of this stage redoes the modules (see "completing an earlier run").
fail_if_nothing_produced() {
  [ -f "$OUT/summary.json" ] || return 0
  node -e '
    const t = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).totals || {};
    if (t.modules > 0 && t.incompleteModules >= t.modules) {
      console.error(`error: none of the ${t.modules} module(s) could be produced (see mirror-ai-run.log: usually a Claude usage limit or auth failure). Restart this stage when the limit resets; finished modules are kept.`);
      process.exit(1);
    }' "$OUT/summary.json"
}

# The report is written by the tool, not by an agent, so it matches a local run exactly.
if [ -n "$PREVIOUS_SCOPE" ]; then
  npm run audit --silent -- --android "$ANDROID" --ios "$IOS" "${SELECT[@]}" --out "$OUT/redone-modules.md" 2>&1 | tee -a "$LOG" >&2
  node --experimental-strip-types src/merge-report.ts "$OUT" "$OUT/redone-modules.md" 2>&1 | tee -a "$LOG" >&2
  rm -f "$OUT/redone-modules.md"
  # The run keeps the scope it started with; only the missing modules were redone.
  read -r RUN_SCOPE RUN_MODULES <<<"$PREVIOUS_SCOPE" || true
  node --experimental-strip-types src/run-meta.ts --out-dir "$OUT" --android "$ANDROID" --ios "$IOS" --scope "$RUN_SCOPE" --modules "${RUN_MODULES:-}" 2>&1 | tee -a "$LOG" >&2 || echo "warning: run.json not written" >&2
  reserve_report_folder 2>&1 | tee -a "$LOG" >&2 || true
  node -e '
    const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const t = s.totals;
    console.error(`${t.modules} module(s), ${t.incompleteModules} still incomplete, score ${s.score}, status ${s.status}, High ${t.high} (${t.highConfirmed} confirmed), Medium ${t.medium}, Low ${t.low}`);' "$OUT/summary.json" 2>&1 | tee -a "$LOG" >&2 || true
  render_report_ui
  write_rule_proposals
  echo "Report: $OUT/parity-report.md" >&2
  fail_if_nothing_produced || exit 1
  exit 0
fi
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

# Numbers for the dashboard (summary.json) and where the run came from (run.json).
if [ "${SELECT[0]}" = "--all" ]; then RUN_SCOPE=project; RUN_MODULES=""
elif [ "${SELECT[0]}" = "--common" ]; then RUN_SCOPE=modules; RUN_MODULES=common
else RUN_SCOPE=modules; RUN_MODULES="${WANTED//,/ }"; fi
node --experimental-strip-types src/report-summary.ts "$OUT/parity-report.md" --out "$OUT/summary.json" 2>&1 | tee -a "$LOG" >&2 || echo "warning: summary.json not written" >&2
node --experimental-strip-types src/run-meta.ts --out-dir "$OUT" --android "$ANDROID" --ios "$IOS" --scope "$RUN_SCOPE" --modules "$RUN_MODULES" 2>&1 | tee -a "$LOG" >&2 || echo "warning: run.json not written" >&2
reserve_report_folder 2>&1 | tee -a "$LOG" >&2 || true
render_report_ui
write_rule_proposals

echo "Report: $OUT/parity-report.md" >&2
[ -f "$OUT/parity-report.html" ] && echo "HTML:   $OUT/parity-report.html" >&2
[ -f "$OUT/parity-report.pdf" ] && echo "PDF:    $OUT/parity-report.pdf" >&2 || echo "PDF:    not produced (Chrome is needed to print it)" >&2
grep -E "Budget:|API-equivalent usage" "$LOG" | tail -1 >&2 || true
fail_if_nothing_produced || exit 1
