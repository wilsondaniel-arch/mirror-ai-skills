#!/usr/bin/env bash
# Start Mirror AI (npm run serve) and open the default browser.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PORT=4173
if [[ -f "$ROOT/.env" ]]; then
  # shellcheck disable=SC1091
  set -a
  # Only export PORT if set in .env (avoid sourcing whole file into shell)
  line="$(grep -E '^PORT=' "$ROOT/.env" 2>/dev/null | tail -1 || true)"
  set +a
  if [[ -n "$line" ]]; then
    PORT="${line#PORT=}"
    PORT="${PORT//\"/}"
  fi
fi

URL="http://127.0.0.1:${PORT}/"
LOG="${ROOT}/.cache/mirror-ai-serve.log"
PIDFILE="${ROOT}/.cache/mirror-ai-serve.pid"
mkdir -p "${ROOT}/.cache"

server_up() {
  curl -sf -o /dev/null --max-time 2 "$URL" 2>/dev/null
}

open_browser() {
  local ok=0
  case "$(uname -s)" in
    Darwin) open "$URL" 2>/dev/null && ok=1 ;;
    Linux)
      if command -v xdg-open >/dev/null 2>&1; then
        xdg-open "$URL" 2>/dev/null && ok=1
      fi
      ;;
    MINGW* | MSYS* | CYGWIN*)
      cmd.exe /c start "" "$URL" 2>/dev/null && ok=1
      ;;
  esac
  if [[ "$ok" != 1 ]]; then
    echo "Open this URL in your browser: $URL"
  fi
}

if server_up; then
  echo "Mirror AI is already running at $URL"
  open_browser
  exit 0
fi

if [[ -f "$PIDFILE" ]]; then
  old_pid="$(cat "$PIDFILE" 2>/dev/null || true)"
  if [[ -n "$old_pid" ]] && kill -0 "$old_pid" 2>/dev/null; then
    echo "Waiting for Mirror AI on $URL…"
    for _ in $(seq 1 30); do
      if server_up; then
        open_browser
        exit 0
      fi
      sleep 0.5
    done
  fi
fi

if [[ ! -d "$ROOT/node_modules" ]] || [[ ! -f "$ROOT/.env" ]]; then
  echo "First-time setup…"
  chmod +x "$ROOT/setup.sh" 2>/dev/null || true
  "$ROOT/setup.sh" --yes --skip-tests
fi

echo "Starting Mirror AI on $URL (log: $LOG)"
nohup env PORT="$PORT" npm run serve >>"$LOG" 2>&1 &
echo $! >"$PIDFILE"

for _ in $(seq 1 60); do
  if server_up; then
    echo "$URL"
    open_browser
    exit 0
  fi
  sleep 0.5
done

echo "ERROR: Server did not become ready. See $LOG"
tail -20 "$LOG" 2>/dev/null || true
exit 1
