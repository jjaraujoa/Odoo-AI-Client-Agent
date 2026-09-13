#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/common.sh"
require_root

SOURCE_ROOT="${1:?Falta la ruta fuente del proyecto.}"
systemctl stop "$N8N_SERVICE"
set -a
# El archivo solo contiene pares CLAVE=VALOR generados localmente.
source "$SERVICE_ENV"
set +a
temp_dir="$(mktemp -d)"
trap 'rm -rf "$temp_dir"' EXIT
chmod 750 "$temp_dir"
chown "$SERVICE_USER:$SERVICE_USER" "$temp_dir"
for workflow in "$SOURCE_ROOT"/n8n/workflows/*.json; do
  echo "Importando $(basename "$workflow")..."
  native_workflow="$temp_dir/$(basename "$workflow")"
  sed 's#http://control-api:8080#http://127.0.0.1:8080#g' \
    "$workflow" >"$native_workflow"
  chown "$SERVICE_USER:$SERVICE_USER" "$native_workflow"
  run_as_agent "$RUNTIME_ROOT/n8n/node_modules/.bin/n8n" \
    import:workflow --input="$native_workflow"
done
systemctl start "$N8N_SERVICE"
echo "Workflows importados. Abra n8n, asigne credenciales y actívelos."
