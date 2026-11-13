#!/usr/bin/env bash
# Files (or updates) the Jira task for one Mirror AI run and attaches the report.
#
#   ark-jira.sh <artifacts_dir> [--update KEY]
#   ark-jira.sh --published <app>/<run folder> --update KEY     # re-describe an issue from a published run
#
# <artifacts_dir> holds summary.json, run.json and parity-report.{html,md}
# from `ark-audit.sh audit`. The issue description is built by
# src/jira-issue.ts (what was audited, branch + commits, totals, per-module
# table, top High findings, report links); no model copies the payload.
# parity-report.html / .md / .pdf are attached. jira-summary.md (`# KEY` +
# browse URL) is written back to <artifacts_dir> for ark-publish.sh.
#
# Environment:
#   ATLASSIAN_USER_EMAIL + ATLASSIAN_API_TOKEN   (or JIRA_USER_EMAIL + JIRA_API_TOKEN)
#   ATLASSIAN_SITE_NAME   e.g. mypaytm  (or JIRA_BASE_URL=https://mypaytm.atlassian.net)
#   MIRROR_AI_JIRA_PROJECT   default TER
#   MIRROR_AI_JIRA_ASSIGNEE  assignee email (optional)
#   MIRROR_AI_REPORTS_REPO   for --published (default git@bitbucket.org:paytmteam/superapp-workspace.git)
set -euo pipefail

APP="$(cd "$(dirname "$0")/.." && pwd)"
ART=""; UPDATE=""; PUBLISHED=""
while [ $# -gt 0 ]; do
  case "$1" in
    --update) UPDATE="${2:?--update needs an issue key}"; shift 2 ;;
    --published) PUBLISHED="${2:?--published needs <app>/<run folder>}"; shift 2 ;;
    *) ART="$1"; shift ;;
  esac
done

EMAIL="${ATLASSIAN_USER_EMAIL:-${JIRA_USER_EMAIL:-}}"
TOKEN="${ATLASSIAN_API_TOKEN:-${JIRA_API_TOKEN:-}}"
BASE="${JIRA_BASE_URL:-}"
[ -n "$BASE" ] || BASE="https://${ATLASSIAN_SITE_NAME:-mypaytm}.atlassian.net"
PROJECT="${MIRROR_AI_JIRA_PROJECT:-TER}"
if [ -z "$EMAIL" ] || [ -z "$TOKEN" ]; then
  echo "ark-jira: ATLASSIAN_USER_EMAIL and ATLASSIAN_API_TOKEN are required (declare them in the workspace secrets)" >&2
  exit 1
fi

if [ -n "$PUBLISHED" ]; then
  REPO="${MIRROR_AI_REPORTS_REPO:-git@bitbucket.org:paytmteam/superapp-workspace.git}"
  APP_ID="${PUBLISHED%%/*}"
  WORK="$(mktemp -d)"
  git clone -q --depth 1 --filter=blob:none --sparse -b "$APP_ID/reports" "$REPO" "$WORK/repo"
  git -C "$WORK/repo" sparse-checkout set "reports/$PUBLISHED"
  [ -d "$WORK/repo/reports/$PUBLISHED" ] || { echo "ark-jira: reports/$PUBLISHED not found on $APP_ID/reports" >&2; exit 1; }
  ART="${ART:-$WORK/artifacts}"
  mkdir -p "$ART"
  cp "$WORK/repo/reports/$PUBLISHED/"* "$ART/"
fi
[ -n "$ART" ] || { echo "usage: ark-jira.sh <artifacts_dir> [--update KEY] | --published <app>/<folder> --update KEY" >&2; exit 1; }
ART="$(cd "$ART" && pwd)"
for f in summary.json run.json; do
  [ -f "$ART/$f" ] || { echo "ark-jira: $ART/$f is missing (run ark-audit.sh audit first)" >&2; exit 1; }
done

jira() { # method path [curl args...] -> body on stdout, fails on HTTP >= 300
  local method="$1" p="$2"; shift 2
  local out code
  out="$(mktemp)"
  code="$(curl -sS -o "$out" -w '%{http_code}' -u "$EMAIL:$TOKEN" -X "$method" -H 'Accept: application/json' "$@" "$BASE$p")"
  if [ "$code" -ge 300 ]; then
    echo "ark-jira: $method $p -> HTTP $code: $(head -c 600 "$out")" >&2
    rm -f "$out"; return 1
  fi
  cat "$out"; rm -f "$out"
}
jsonget() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=JSON.parse(s||"null");const r=new Function("v","return "+process.argv[1])(v);process.stdout.write(r==null?"":String(r))})' "$1"; }

node --experimental-strip-types "$APP/src/jira-issue.ts" "$ART" --project "$PROJECT" --out "$ART/jira-issue.json" >&2

ASSIGNEE_ID=""
if [ -n "${MIRROR_AI_JIRA_ASSIGNEE:-}" ]; then
  ASSIGNEE_ID="$(jira GET "/rest/api/3/user/search?query=$(node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$MIRROR_AI_JIRA_ASSIGNEE")" | jsonget 'v && v[0] && v[0].accountId' || true)"
fi
BODY="$(node -e '
  const fs=require("fs"); const i=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
  if (process.argv[2]) i.fields.assignee={id:process.argv[2]};
  if (process.argv[3]) { delete i.fields.project; delete i.fields.issuetype; }
  process.stdout.write(JSON.stringify(i));' "$ART/jira-issue.json" "$ASSIGNEE_ID" "$UPDATE")"

if [ -n "$UPDATE" ]; then
  KEY="$UPDATE"
  jira PUT "/rest/api/3/issue/$KEY" -H 'Content-Type: application/json' --data-binary "$BODY" >/dev/null
  echo "ark-jira: updated $KEY" >&2
else
  KEY="$(jira POST /rest/api/3/issue -H 'Content-Type: application/json' --data-binary "$BODY" | jsonget 'v.key')"
  [ -n "$KEY" ] || { echo "ark-jira: create returned no key" >&2; exit 1; }
  echo "ark-jira: created $KEY" >&2
fi

# Check the description really landed (the failure this script exists to prevent).
HAS_DESC="$(jira GET "/rest/api/3/issue/$KEY?fields=description" | jsonget 'v.fields && v.fields.description && v.fields.description.content ? v.fields.description.content.length : 0')"
[ "${HAS_DESC:-0}" -gt 0 ] || { echo "ark-jira: $KEY has no description after the write" >&2; exit 1; }

ATTACHED=()
for f in parity-report.html parity-report.md parity-report.pdf; do
  [ -f "$ART/$f" ] || continue
  if jira POST "/rest/api/3/issue/$KEY/attachments" -H 'X-Atlassian-Token: no-check' -F "file=@$ART/$f" >/dev/null; then
    ATTACHED+=("$f")
  else
    echo "ark-jira: could not attach $f" >&2
  fi
done

printf '# %s\n%s/browse/%s\n' "$KEY" "$BASE" "$KEY" > "$ART/jira-summary.md"
echo "ark-jira: $KEY description ${HAS_DESC} blocks; attached: ${ATTACHED[*]:-none}" >&2
echo "$KEY $BASE/browse/$KEY"
