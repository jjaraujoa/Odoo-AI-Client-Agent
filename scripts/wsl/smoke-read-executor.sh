#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/common.sh"
require_root

SOURCE_ROOT="${1:?Falta la ruta fuente del proyecto.}"
CLIENT_SLUG="${2:-piloto-odoo19}"
[[ "$CLIENT_SLUG" =~ ^[a-z0-9][a-z0-9-]{1,62}$ ]] || { echo "ClientSlug inválido." >&2; exit 1; }

set -a
source "$SERVICE_ENV"
set +a

cd "$RUNTIME_ROOT/control-api"
runuser -u "$SERVICE_USER" --preserve-environment -- \
  "$NODE_HOME/bin/node" scripts/smoke-read-agent.js \
  --client "$CLIENT_SLUG" --local-executor-only
