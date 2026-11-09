#!/usr/bin/env bash
# Publishes one Mirror AI run to superapp-workspace and opens (or updates) the
# app's PR to main.
#
#   ark-publish.sh <artifacts_dir>
#
# <artifacts_dir> holds parity-report.md (+ .html, .pdf), summary.json and
# run.json from `ark-audit.sh audit`, and optionally jira-summary.md. The run
# is committed to reports/<app>/<run folder>/ on branch <app>/reports, the
# app's reports/<app>/README.md is regenerated, the branch is pushed, and a PR
# to main is opened — or, when one is already open for that branch, commented
# on. publish.json (branch, folder, report URL, PR URL) is written back to
# <artifacts_dir>.
#
# Environment:
#   MIRROR_AI_REPORTS_REPO   clone URL   (default git@bitbucket.org:paytmteam/superapp-workspace.git)
#   MIRROR_AI_REPORTS_API    workspace/repo for the REST API (default paytmteam/superapp-workspace)
#   MIRROR_AI_REPORTS_BASE   PR target branch (default main)
#   MIRROR_AI_REPORTS_BRANCH override the <app>/reports branch name
#   BITBUCKET_TOKEN, or BITBUCKET_USERNAME + BITBUCKET_APP_PASSWORD
#                            PR access; without them the branch is pushed and no PR is made
#   MIRROR_AI_DASHBOARD_TOPLEVEL=1  also regenerate reports/README.md, dashboard.html and
#                            index.json on the branch (use when main has no pipeline doing it)
set -euo pipefail

ART="$(cd "${1:?usage: ark-publish.sh <artifacts_dir>}" && pwd)"
APP="$(cd "$(dirname "$0")/.." && pwd)"
REPO="${MIRROR_AI_REPORTS_REPO:-git@bitbucket.org:paytmteam/superapp-workspace.git}"
API_REPO="${MIRROR_AI_REPORTS_API:-paytmteam/superapp-workspace}"
BASE="${MIRROR_AI_REPORTS_BASE:-main}"
API="https://api.bitbucket.org/2.0/repositories/$API_REPO"

for f in parity-report.md summary.json run.json; do
  [ -f "$ART/$f" ] || { echo "ark-publish: $ART/$f is missing (run ark-audit.sh audit first)" >&2; exit 1; }
done

json() { node -e 'const v=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))[process.argv[2]];process.stdout.write(v==null?"":String(v))' "$1" "$2"; }

# Fold the Jira key and link in from the Jira stage, when it ran.
RUN_JSON="$(mktemp)"
node -e '
const fs = require("fs");
const [runFile, jiraFile, out] = process.argv.slice(1);
const run = JSON.parse(fs.readFileSync(runFile, "utf8"));
if (fs.existsSync(jiraFile)) {
  const text = fs.readFileSync(jiraFile, "utf8");
  const url = (text.match(/https?:\/\/\S+\/browse\/([A-Z][A-Z0-9]+-\d+)/) || [])[0];
  const key = (url && url.split("/browse/")[1]) || (text.match(/\b[A-Z][A-Z0-9]+-\d+\b/) || [])[0];
  if (key) run.jiraKey = key;
  if (url) run.jiraUrl = url;
}
fs.writeFileSync(out, JSON.stringify(run, null, 2) + "\n");
' "$ART/run.json" "$ART/jira-summary.md" "$RUN_JSON"

APP_ID="$(json "$RUN_JSON" app)"
FOLDER="$(json "$RUN_JSON" folder)"
BRANCH="${MIRROR_AI_REPORTS_BRANCH:-$(json "$RUN_JSON" branchRef)}"
REPORT_URL="$(json "$RUN_JSON" reportUrl)"
[ -n "$APP_ID" ] && [ -n "$FOLDER" ] && [ -n "$BRANCH" ] || { echo "ark-publish: run.json lacks app, folder or branchRef" >&2; exit 1; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK" "$RUN_JSON"' EXIT
# Partial, sparse clone: only reports/ is checked out, so a large repo stays cheap.
git clone --quiet --filter=blob:none --sparse --branch "$BASE" "$REPO" "$WORK/repo"
cd "$WORK/repo"
git sparse-checkout set reports
git config user.name "${GIT_AUTHOR_NAME:-Mirror AI}"
git config user.email "${GIT_AUTHOR_EMAIL:-mirror-ai@noreply.local}"

if git ls-remote --exit-code --heads origin "$BRANCH" >/dev/null 2>&1; then
  git fetch --quiet origin "+refs/heads/$BRANCH:refs/remotes/origin/$BRANCH"
  git checkout --quiet -B "$BRANCH" "origin/$BRANCH"
  # Keep the branch current with main. Only generated files can clash; main wins and they are rebuilt below.
  git merge --quiet --no-edit -X theirs "origin/$BASE" >/dev/null || { echo "ark-publish: could not merge $BASE into $BRANCH" >&2; exit 1; }
else
  git checkout --quiet -B "$BRANCH" "origin/$BASE"
fi

mkdir -p reports
if [ ! -f reports/apps.json ]; then
  cat > reports/apps.json <<'APPS'
[
  { "id": "caribbean", "name": "Caribbean SuperApp", "market": "superapp-caribbean", "jiraProject": "TER" },
  { "id": "myliberty-pr", "name": "MyLiberty PR", "market": "myliberty-pr", "jiraProject": "TER" },
  { "id": "ooredoo-maldives", "name": "Ooredoo Maldives", "market": "ooredoo-maldives", "jiraProject": "TER" },
  { "id": "panama", "name": "Panama", "market": "panama", "jiraProject": "TER" }
]
APPS
fi

DEST="reports/$APP_ID/$FOLDER"
mkdir -p "$DEST"
for f in parity-report.md parity-report.html parity-report.pdf summary.json; do
  [ -f "$ART/$f" ] && cp "$ART/$f" "$DEST/$f"
done
cp "$RUN_JSON" "$DEST/run.json"

if [ "${MIRROR_AI_DASHBOARD_TOPLEVEL:-}" = "1" ]; then
  node --experimental-strip-types "$APP/src/dashboard.ts" reports --app "$APP_ID" >&2
else
  node --experimental-strip-types "$APP/src/dashboard.ts" reports --app "$APP_ID" --app-only >&2
fi

git add reports
if git diff --cached --quiet; then
  echo "ark-publish: nothing new to commit for $DEST" >&2
else
  SCOPE="$(node -e 'const r=require(process.argv[1]);process.stdout.write(r.scope==="project"?"whole project":(r.modules||[]).join(", "))' "$PWD/$DEST/run.json")"
  git commit --quiet -m "Mirror AI: $APP_ID report ($SCOPE) $(date -u +%Y-%m-%d)" -m "Run folder: $DEST"
fi

pushed=0
for attempt in 1 2 3; do
  if git push --quiet origin "HEAD:refs/heads/$BRANCH" 2>"$WORK/push.err"; then pushed=1; break; fi
  if grep -qiE "cannot lock ref|directory file conflict|refs/heads/[^ ]+ exists" "$WORK/push.err"; then
    cat "$WORK/push.err" >&2
    echo "ark-publish: a branch named '${BRANCH%%/*}' blocks '$BRANCH'. Set MIRROR_AI_REPORTS_BRANCH to another name." >&2
    exit 1
  fi
  echo "ark-publish: push attempt $attempt rejected; rebasing on origin/$BRANCH" >&2
  git fetch --quiet origin "+refs/heads/$BRANCH:refs/remotes/origin/$BRANCH" && git rebase --quiet "origin/$BRANCH" || true
done
[ "$pushed" = 1 ] || { cat "$WORK/push.err" >&2; echo "ark-publish: could not push $BRANCH" >&2; exit 1; }
COMMIT="$(git rev-parse HEAD)"
echo "ark-publish: pushed $DEST to $BRANCH @ ${COMMIT:0:10}" >&2

# ---- PR: open one, or comment on the one already open for this branch.
AUTH=()
if [ -n "${BITBUCKET_TOKEN:-}" ]; then AUTH=(-H "Authorization: Bearer $BITBUCKET_TOKEN")
elif [ -n "${BITBUCKET_USERNAME:-}" ] && [ -n "${BITBUCKET_APP_PASSWORD:-}" ]; then AUTH=(-u "$BITBUCKET_USERNAME:$BITBUCKET_APP_PASSWORD")
fi

PR_URL=""; PR_ID=""; PR_ACTION="none"
if [ ${#AUTH[@]} -gt 0 ]; then
  BODY="$(node -e '
const fs = require("fs");
const [summaryFile, runFile, folder, reportUrl] = process.argv.slice(1);
const s = JSON.parse(fs.readFileSync(summaryFile, "utf8"));
const r = JSON.parse(fs.readFileSync(runFile, "utf8"));
const icon = { red: "🔴", amber: "🟠", green: "🟢", grey: "⚪" }[s.status] || "";
const t = s.totals;
const lines = [
  `**${r.app}** · ${r.scope === "project" ? "whole project" : (r.modules || []).join(", ")} · branch \`${r.branch || "?"}\` · ${r.date.slice(0, 16).replace("T", " ")} UTC`,
  "",
  `${icon} score ${s.score ?? "—"} · High ${t.high} (${t.highConfirmed} confirmed) · Medium ${t.medium} · Low ${t.low} · API drift ${t.apiDrift} · ${t.modules} module(s)`,
  "",
  `Report: [HTML](${reportUrl})` + (r.reportMdUrl ? ` · [md](${r.reportMdUrl})` : "") + ` (${folder})` + (r.jiraKey ? ` · Jira: ${r.jiraUrl ? `[${r.jiraKey}](${r.jiraUrl})` : r.jiraKey}` : ""),
];
process.stdout.write(lines.join("\n"));
' "$ART/summary.json" "$PWD/$DEST/run.json" "$FOLDER" "$REPORT_URL")"
  Q="$(node -e 'process.stdout.write(encodeURIComponent(`source.branch.name="${process.argv[1]}" AND state="OPEN"`))' "$BRANCH")"
  OPEN="$(curl -fsS "${AUTH[@]}" "$API/pullrequests?q=$Q" || true)"
  PR_ID="$(printf '%s' "$OPEN" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const v=JSON.parse(d).values||[];process.stdout.write(v[0]?String(v[0].id):"")}catch{}})')"
  if [ -n "$PR_ID" ]; then
    node -e 'process.stdout.write(JSON.stringify({content:{raw:"New run published:\n\n"+process.argv[1]}}))' "$BODY" > "$WORK/comment.json"
    curl -fsS "${AUTH[@]}" -H "Content-Type: application/json" -X POST --data @"$WORK/comment.json" "$API/pullrequests/$PR_ID/comments" >/dev/null \
      && PR_ACTION="commented" || echo "ark-publish: could not comment on PR $PR_ID" >&2
  else
    node -e '
const [branch, base, app, body] = process.argv.slice(1);
process.stdout.write(JSON.stringify({
  title: `Mirror AI reports: ${app}`,
  description: body + "\n\nOpened by the telco-apps-mirror-audit flow. Later runs of this app are pushed to this PR until it is merged.",
  source: { branch: { name: branch } },
  destination: { branch: { name: base } },
  close_source_branch: false,
}));' "$BRANCH" "$BASE" "$APP_ID" "$BODY" > "$WORK/pr.json"
    CREATED="$(curl -fsS "${AUTH[@]}" -H "Content-Type: application/json" -X POST --data @"$WORK/pr.json" "$API/pullrequests" || true)"
    PR_ID="$(printf '%s' "$CREATED" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{process.stdout.write(String(JSON.parse(d).id||""))}catch{}})')"
    [ -n "$PR_ID" ] && PR_ACTION="opened" || echo "ark-publish: could not open a PR (check the Bitbucket credentials' pull-request write scope)" >&2
  fi
  [ -n "$PR_ID" ] && PR_URL="https://bitbucket.org/$API_REPO/pull-requests/$PR_ID"
else
  echo "ark-publish: no BITBUCKET_TOKEN or BITBUCKET_USERNAME/BITBUCKET_APP_PASSWORD; branch pushed, no PR made" >&2
fi

node -e '
const fs = require("fs");
const [out, branch, folder, reportUrl, commit, prUrl, prId, action, app] = process.argv.slice(1);
fs.writeFileSync(out, JSON.stringify({ app, branch, folder, reportUrl, commit, prUrl: prUrl || null, prId: prId ? Number(prId) : null, prAction: action }, null, 2) + "\n");
' "$ART/publish.json" "$BRANCH" "$DEST" "$REPORT_URL" "$COMMIT" "$PR_URL" "$PR_ID" "$PR_ACTION" "$APP_ID"
echo "ark-publish: ${PR_URL:-no PR} ($PR_ACTION) · report $REPORT_URL" >&2
