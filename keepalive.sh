#!/usr/bin/env bash
set -euo pipefail
DIR=/workspace/paper-trader
PIDFILE="$DIR/run.pid"
LOG="$DIR/run.log"
cd "$DIR"
if [[ -f "$PIDFILE" ]]; then
  pid=$(cat "$PIDFILE" || true)
  if [[ -n "${pid:-}" ]] && kill -0 "$pid" 2>/dev/null; then
    exit 0
  fi
fi
if ss -ltnp 2>/dev/null | grep -q ':8787'; then
  exit 0
fi
if [[ -z "${WECOM_WEBHOOK_URL:-}" && -f "$DIR/.wecom_url" ]]; then
  export WECOM_WEBHOOK_URL=$(cat "$DIR/.wecom_url")
fi
if [[ -z "${WECOM_WEBHOOK_URL:-}" ]]; then
  for p in $(pgrep -f 'node app.js' || true); do
    u=$(tr '\0' '\n' < /proc/$p/environ 2>/dev/null | sed -n 's/^WECOM_WEBHOOK_URL=//p' | head -1)
    if [[ -n "$u" ]]; then export WECOM_WEBHOOK_URL="$u"; break; fi
  done
fi
export WECOM_WEBHOOK_URL="${WECOM_WEBHOOK_URL:-}"
nohup env WECOM_WEBHOOK_URL="$WECOM_WEBHOOK_URL" node app.js >>"$LOG" 2>&1 &
echo $! >"$PIDFILE"
echo "[keepalive] restarted pid=$(cat "$PIDFILE") at $(date '+%F %T')" >>"$LOG"
