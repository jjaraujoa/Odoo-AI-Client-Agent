#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/common.sh"
require_root

SOURCE_ROOT="${1:?Falta la ruta fuente del proyecto.}"
SOURCE_ENV="$SOURCE_ROOT/.env"
[[ -f "$SOURCE_ENV" ]] || {
  echo "No existe $SOURCE_ENV." >&2
  exit 1
}

upsert_from_source() {
  local source_key="$1"
  local target_key="${2:-$1}"
  local value
  local line
  local found=false
  local temp_file

  value="$(read_env_value "$SOURCE_ENV" "$source_key")"
  temp_file="$(mktemp)"
  while IFS= read -r line || [[ -n "$line" ]]; do
    if [[ "$line" == "$target_key="* ]]; then
      printf '%s=%s\n' "$target_key" "$value" >>"$temp_file"
      found=true
    else
      printf '%s\n' "$line" >>"$temp_file"
    fi
  done <"$SERVICE_ENV"
  if [[ "$found" == false ]]; then
    printf '%s=%s\n' "$target_key" "$value" >>"$temp_file"
  fi
  install -o root -g root -m 600 "$temp_file" "$SERVICE_ENV"
  rm -f "$temp_file"
}

remove_key() {
  local target_key="$1"
  local temp_file
  temp_file="$(mktemp)"
  grep -v "^${target_key}=" "$SERVICE_ENV" >"$temp_file" || true
  install -o root -g root -m 600 "$temp_file" "$SERVICE_ENV"
  rm -f "$temp_file"
}

upsert_from_source OPENAI_API_KEY
upsert_from_source ANTHROPIC_API_KEY
upsert_from_source N8N_WEBHOOK_URL
remove_key WEBHOOK_URL

systemctl restart "$CONTROL_SERVICE" "$N8N_SERVICE"
echo "Secretos locales actualizados sin mostrarlos en la consola."
