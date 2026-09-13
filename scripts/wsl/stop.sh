#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/common.sh"
require_root

systemctl stop "$N8N_SERVICE" "$CONTROL_SERVICE"
echo "n8n y control-api detenidos. PostgreSQL y ClamAV permanecen disponibles."
