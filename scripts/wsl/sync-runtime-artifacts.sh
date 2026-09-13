#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/common.sh"
require_root

SOURCE_ROOT="${1:?Falta la ruta fuente del proyecto.}"

install -d -o "$SERVICE_USER" -g "$SERVICE_USER" \
  "$RUNTIME_ROOT/n8n/workflows" \
  "$RUNTIME_ROOT/db/migrations" \
  "$RUNTIME_ROOT/control-api/src" \
  "$RUNTIME_ROOT/control-api/scripts" \
  "$RUNTIME_ROOT/control-api/test"

cp -a "$SOURCE_ROOT/n8n/workflows/." "$RUNTIME_ROOT/n8n/workflows/"
cp -a "$SOURCE_ROOT/db/migrations/." "$RUNTIME_ROOT/db/migrations/"
cp -a "$SOURCE_ROOT/control-api/src/." "$RUNTIME_ROOT/control-api/src/"
cp -a "$SOURCE_ROOT/control-api/scripts/." "$RUNTIME_ROOT/control-api/scripts/"
cp -a "$SOURCE_ROOT/control-api/test/." "$RUNTIME_ROOT/control-api/test/"
cp "$SOURCE_ROOT/control-api/package.json" "$RUNTIME_ROOT/control-api/package.json"
cp "$SOURCE_ROOT/.env.example" "$RUNTIME_ROOT/.env.example"

chown -R "$SERVICE_USER:$SERVICE_USER" \
  "$RUNTIME_ROOT/n8n/workflows" \
  "$RUNTIME_ROOT/db" \
  "$RUNTIME_ROOT/control-api/src" \
  "$RUNTIME_ROOT/control-api/scripts" \
  "$RUNTIME_ROOT/control-api/test" \
  "$RUNTIME_ROOT/control-api/package.json" \
  "$RUNTIME_ROOT/.env.example"

systemctl restart "$CONTROL_SERVICE"
echo "Artefactos de prueba sincronizados en WSL."
