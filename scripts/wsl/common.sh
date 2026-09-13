#!/usr/bin/env bash
set -Eeuo pipefail

RUNTIME_ROOT="/opt/odoo-ai-agent"
NODE_VERSION="24.18.0"
NODE_HOME="$RUNTIME_ROOT/node"
SERVICE_ENV="/etc/odoo-ai-agent.env"
SERVICE_USER="odooagent"
CONTROL_SERVICE="odoo-ai-control.service"
N8N_SERVICE="odoo-ai-n8n.service"

require_root() {
  if [[ "${EUID}" -ne 0 ]]; then
    echo "Este script debe ejecutarse como root dentro de WSL." >&2
    exit 1
  fi
}

read_env_value() {
  local file="$1"
  local key="$2"
  awk -v wanted="$key" '
    index($0, wanted "=") == 1 {
      sub(/^[^=]*=/, "")
      print
      exit
    }
  ' "$file"
}

validate_identifier() {
  local value="$1"
  local label="$2"
  if [[ ! "$value" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
    echo "$label contiene caracteres no permitidos." >&2
    exit 1
  fi
}

run_as_agent() {
  runuser -u "$SERVICE_USER" -- env \
    PATH="$NODE_HOME/bin:/usr/local/bin:/usr/bin:/bin" \
    HOME="/var/lib/$SERVICE_USER" \
    "$@"
}
