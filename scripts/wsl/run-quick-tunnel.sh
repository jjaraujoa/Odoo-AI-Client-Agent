#!/usr/bin/env bash
set -Eeuo pipefail

RUNTIME_ROOT="/opt/odoo-ai-agent"
NODE_HOME="$RUNTIME_ROOT/node"
PROXY_SCRIPT="$RUNTIME_ROOT/control-api/src/quick-tunnel-proxy.js"
CLOUDFLARED="$RUNTIME_ROOT/cloudflared/cloudflared"

proxy_pid=""
cleanup() {
  if [[ -n "$proxy_pid" ]] && kill -0 "$proxy_pid" 2>/dev/null; then
    kill "$proxy_pid" 2>/dev/null || true
    wait "$proxy_pid" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

"$NODE_HOME/bin/node" "$PROXY_SCRIPT" &
proxy_pid=$!

for _ in $(seq 1 20); do
  status="$(curl --silent --output /dev/null --write-out '%{http_code}' \
    http://127.0.0.1:5680/ || true)"
  if [[ "$status" == "404" ]]; then
    break
  fi
  sleep 0.25
done

if ! kill -0 "$proxy_pid" 2>/dev/null; then
  echo "El proxy temporal no pudo iniciarse." >&2
  exit 1
fi

"$CLOUDFLARED" tunnel --no-autoupdate --loglevel info \
  --url http://127.0.0.1:5680
