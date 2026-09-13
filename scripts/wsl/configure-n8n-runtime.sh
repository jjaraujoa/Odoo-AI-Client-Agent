#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/common.sh"
require_root

upsert_env() {
  local key="$1"
  local value="$2"
  if grep -q "^${key}=" "$SERVICE_ENV"; then
    sed -i "s#^${key}=.*#${key}=${value}#" "$SERVICE_ENV"
  else
    printf '%s=%s\n' "$key" "$value" >>"$SERVICE_ENV"
  fi
}

upsert_env N8N_HOST localhost
upsert_env N8N_LISTEN_ADDRESS 0.0.0.0
upsert_env N8N_UNVERIFIED_PACKAGES_ENABLED false
upsert_env N8N_RUNNERS_TASK_TIMEOUT 60
upsert_env N8N_COMPRESSION_NODE_MAX_DECOMPRESSED_SIZE_BYTES 268435456
upsert_env N8N_COMPRESSION_NODE_MAX_ZIP_ENTRIES 1000
upsert_env N8N_BLOCK_ENV_ACCESS_IN_NODE true
upsert_env N8N_BLOCK_FILE_ACCESS_TO_N8N_FILES true
upsert_env N8N_ENFORCE_SETTINGS_FILE_PERMISSIONS true
upsert_env N8N_ENFORCE_GLOBAL_USER_AGENT true

chmod 600 "$SERVICE_ENV"
chown root:root "$SERVICE_ENV"
systemctl restart "$N8N_SERVICE"

for _ in {1..30}; do
  if curl --fail --silent --output /dev/null http://127.0.0.1:5678; then
    echo "n8n configurado y disponible por IPv4."
    exit 0
  fi
  sleep 2
done

echo "n8n no respondió después de actualizar su configuración." >&2
exit 1
