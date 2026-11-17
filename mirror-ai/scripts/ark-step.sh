#!/usr/bin/env bash
# One step of a Mirror AI Ark flow, run by an agent stage straight from this
# skill checkout (no workspace action, so the flow uses this repo's code):
#
#   ark-step.sh index|audit|publish start   start the step in the background (no-op while it runs)
#   ark-step.sh index|audit|publish wait    wait up to MIRROR_AI_STEP_WAIT seconds (default 100), then print
#                                           the log tail and a last line: STATUS: running | done | failed (exit N)
#
# The app is installed into MIRROR_AI_HOME (default ~/.mirror-ai-v2) so it never
# mixes with a copy another skill version installed into ~/.mirror-ai.
# Needs WORKSPACE_ROOT, MIRROR_AI_ANDROID_PATH and MIRROR_AI_IOS_PATH (the Mirror AI workspaces set them).
set -uo pipefail
STEP="${1:-}"; MODE="${2:-wait}"
case "$STEP" in index|audit|publish) ;; *) echo "usage: $0 index|audit|publish start|wait" >&2; exit 2 ;; esac
: "${WORKSPACE_ROOT:?WORKSPACE_ROOT is not set}"
SKILL_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ART="$WORKSPACE_ROOT/.ark/artifacts"
STATE="$WORKSPACE_ROOT/.ark/mirror-ai-steps"
mkdir -p "$ART" "$STATE"
LOG="$STATE/$STEP.log"; EXIT="$STATE/$STEP.exit"; PID="$STATE/$STEP.pid"
export MIRROR_AI_HOME="${MIRROR_AI_HOME:-$HOME/.mirror-ai-v2}"

running() { [ -f "$PID" ] && kill -0 "$(cat "$PID")" 2>/dev/null; }

if [ "$MODE" = "--run" ]; then
  APP="$(bash "$SKILL_ROOT/scripts/bootstrap.sh" | tail -1)"
  case "$STEP" in
    index) "$APP/scripts/ark-audit.sh" index "$MIRROR_AI_ANDROID_PATH" "$MIRROR_AI_IOS_PATH" "$ART" ;;
    audit) "$APP/scripts/ark-audit.sh" audit "$MIRROR_AI_ANDROID_PATH" "$MIRROR_AI_IOS_PATH" "$ART" ;;
    publish) "$APP/scripts/ark-publish.sh" "$ART" ;;
  esac
  code=$?
  echo "$code" > "$EXIT"
  exit "$code"
fi

if [ "$MODE" = "start" ]; then
  if running; then
    echo "already running (pid $(cat "$PID"))"
  else
    rm -f "$EXIT"
    # Detached, so it outlives the shell that started it.
    if command -v setsid >/dev/null 2>&1; then
      nohup setsid bash "$0" "$STEP" --run > "$LOG" 2>&1 < /dev/null &
    else
      nohup bash "$0" "$STEP" --run > "$LOG" 2>&1 < /dev/null &
    fi
    echo $! > "$PID"
    echo "started $STEP (pid $!), log: $LOG"
  fi
fi

deadline=$((SECONDS + ${MIRROR_AI_STEP_WAIT:-100}))
while [ ! -f "$EXIT" ] && running && [ "$SECONDS" -lt "$deadline" ]; do sleep 10; done
tail -n 12 "$LOG" 2>/dev/null | cut -c1-300
if [ -f "$EXIT" ]; then
  code="$(cat "$EXIT")"
  [ "$code" = "0" ] && echo "STATUS: done" || echo "STATUS: failed (exit $code)"
elif running; then
  echo "STATUS: running"
else
  echo "STATUS: failed (the $STEP process stopped without an exit code; run start again)"
fi
