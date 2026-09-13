#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/common.sh"
require_root

SOURCE_ROOT="${1:?Falta la ruta fuente del proyecto.}"
VERSION="2026.7.2"
UNIT="odoo-ai-quick-tunnel.service"
INSTALL_DIR="$RUNTIME_ROOT/cloudflared"
CLOUDFLARED="$INSTALL_DIR/cloudflared"
RUNNER="$INSTALL_DIR/run-quick-tunnel.sh"

if ! curl --fail --silent http://127.0.0.1:5678/ >/dev/null; then
  echo "n8n no está disponible en http://127.0.0.1:5678." >&2
  exit 1
fi

install -d -o root -g root -m 0755 "$INSTALL_DIR"
install -o root -g root -m 0755 \
  "$SOURCE_ROOT/scripts/wsl/run-quick-tunnel.sh" "$RUNNER"

if [[ ! -x "$CLOUDFLARED" ]] \
    || ! "$CLOUDFLARED" --version 2>/dev/null | grep -Fq "$VERSION"; then
  case "$(uname -m)" in
    x86_64) asset="cloudflared-linux-amd64" ;;
    aarch64|arm64) asset="cloudflared-linux-arm64" ;;
    *) echo "Arquitectura WSL no compatible con el instalador temporal." >&2; exit 1 ;;
  esac
  temporary="$(mktemp)"
  trap 'rm -f "$temporary"' EXIT
  curl --fail --silent --show-error --location \
    "https://github.com/cloudflare/cloudflared/releases/download/$VERSION/$asset" \
    --output "$temporary"
  install -o root -g root -m 0755 "$temporary" "$CLOUDFLARED"
  "$CLOUDFLARED" --version 2>/dev/null | grep -Fq "$VERSION" || {
    echo "La versión descargada de cloudflared no coincide con $VERSION." >&2
    exit 1
  }
fi

systemctl stop "$UNIT" >/dev/null 2>&1 || true
systemctl reset-failed "$UNIT" >/dev/null 2>&1 || true
started_at="$(date --iso-8601=seconds)"
systemd-run --unit="$UNIT" --collect \
  --property="User=$SERVICE_USER" \
  --property="Group=$SERVICE_USER" \
  --property="WorkingDirectory=$RUNTIME_ROOT/control-api" \
  --setenv="HOME=/var/lib/$SERVICE_USER" \
  --setenv="PATH=$NODE_HOME/bin:/usr/local/bin:/usr/bin:/bin" \
  "$RUNNER" >/dev/null

url=""
for _ in $(seq 1 60); do
  url="$(journalctl -u "$UNIT" --since "$started_at" --no-pager 2>/dev/null \
    | grep -Eo 'https://[a-z0-9-]+\.trycloudflare\.com' | tail -n 1 || true)"
  if [[ -n "$url" ]]; then
    break
  fi
  if ! systemctl is-active --quiet "$UNIT"; then
    journalctl -u "$UNIT" --since "$started_at" --no-pager >&2 || true
    echo "El Quick Tunnel terminó antes de entregar una URL." >&2
    exit 1
  fi
  sleep 1
done

if [[ -z "$url" ]]; then
  echo "Cloudflare no entregó una URL temporal dentro del tiempo esperado." >&2
  exit 1
fi

for _ in $(seq 1 30); do
  status="$(curl --silent --output /dev/null --write-out '%{http_code}' "$url/" || true)"
  if [[ "$status" == "404" ]]; then
    echo "QUICK_TUNNEL_URL=$url"
    exit 0
  fi
  sleep 1
done

echo "El túnel obtuvo una URL, pero la ruta pública limitada no respondió correctamente." >&2
exit 1
