#!/usr/bin/env bash
# Attaches the Mirror AI report files to the Jira ticket the flow's jira stage
# created (key from <artifacts>/jira-summary.md). Called at the end of
# ark-publish.sh, after the final HTML is rendered with the ticket in its header.
#
#   ark-attach-jira.sh <artifacts_dir>
#
# Jira only accepts attachments as multipart/form-data with an API token, which the
# Atlassian MCP tools in an Ark agent stage cannot send (they take a JSON body), so
# this runs in the publish action with:
#   ATLASSIAN_USER_EMAIL + ATLASSIAN_API_TOKEN   (or JIRA_USER_EMAIL + JIRA_API_TOKEN)
#   ATLASSIAN_SITE_NAME e.g. mypaytm             (or JIRA_BASE_URL=https://mypaytm.atlassian.net)
#
# Never fails the caller: every outcome (attached, already attached, skipped and
# why) is printed and written to <artifacts_dir>/jira-attach.json.
set -uo pipefail

ART="${1:-}"
[ -n "$ART" ] && [ -d "$ART" ] || { echo "usage: $0 <artifacts_dir>" >&2; exit 0; }
ART="$(cd "$ART" && pwd)"
RESULT="$ART/jira-attach.json"

finish() { # status message [attached...]
  local status="$1" message="$2"; shift 2
  node -e '
    const [out, key, status, message, ...files] = process.argv.slice(1);
    require("fs").writeFileSync(out, JSON.stringify({ key: key || null, status, message, attached: files }, null, 2) + "\n");
  ' "$RESULT" "${KEY:-}" "$status" "$message" "$@"
  echo "ark-attach-jira: $status — $message${*:+ ($*)}" >&2
  exit 0
}

KEY=""
if [ -f "$ART/jira-summary.md" ]; then
  KEY="$(grep -oE '/browse/[A-Z][A-Z0-9]+-[0-9]+' "$ART/jira-summary.md" | head -1 | sed 's#/browse/##')"
  [ -n "$KEY" ] || KEY="$(grep -oE '\b[A-Z][A-Z0-9]+-[0-9]+\b' "$ART/jira-summary.md" | head -1)"
fi
[ -n "$KEY" ] || finish skipped "no Jira ticket: jira-summary.md is missing or has no key (the jira stage did not run or failed)"

EMAIL="${ATLASSIAN_USER_EMAIL:-${JIRA_USER_EMAIL:-}}"
TOKEN="${ATLASSIAN_API_TOKEN:-${JIRA_API_TOKEN:-}}"
BASE="${JIRA_BASE_URL:-}"
[ -n "$BASE" ] || BASE="https://${ATLASSIAN_SITE_NAME:-mypaytm}.atlassian.net"
BASE="${BASE%/}"
if [ -z "$EMAIL" ] || [ -z "$TOKEN" ]; then
  finish skipped "ATLASSIAN_USER_EMAIL / ATLASSIAN_API_TOKEN are not set in this workspace; the report is linked from the ticket but not attached"
fi

FILES=()
for f in parity-report.html parity-report.pdf parity-report.md; do
  [ -s "$ART/$f" ] && FILES+=("$f")
done
[ ${#FILES[@]} -gt 0 ] || finish skipped "no report files in $ART"

# What is already on the ticket, so a re-run does not attach the same file twice.
EXISTING="$(curl -sS -u "$EMAIL:$TOKEN" -H 'Accept: application/json' "$BASE/rest/api/3/issue/$KEY?fields=attachment" 2>/dev/null \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const a=JSON.parse(s).fields.attachment||[];console.log(a.map(x=>x.filename).join("\n"))}catch{process.exit(1)}})')" \
  || finish failed "could not read $KEY (check the token's access to the project)"

ATTACHED=(); FAILED=()
for f in "${FILES[@]}"; do
  if printf '%s\n' "$EXISTING" | grep -qxF "$f"; then
    ATTACHED+=("$f (already)")
    continue
  fi
  out="$(mktemp)"
  code="$(curl -sS -o "$out" -w '%{http_code}' -u "$EMAIL:$TOKEN" -X POST \
    -H 'Accept: application/json' -H 'X-Atlassian-Token: no-check' \
    -F "file=@$ART/$f" "$BASE/rest/api/3/issue/$KEY/attachments")"
  if [ "$code" -lt 300 ]; then ATTACHED+=("$f"); else FAILED+=("$f: HTTP $code $(head -c 200 "$out")"); fi
  rm -f "$out"
done

if [ ${#FAILED[@]} -gt 0 ]; then
  finish partial "attached to $KEY: ${ATTACHED[*]:-none}; failed: ${FAILED[*]}" "${ATTACHED[@]}"
fi
finish attached "report attached to $KEY" "${ATTACHED[@]}"
