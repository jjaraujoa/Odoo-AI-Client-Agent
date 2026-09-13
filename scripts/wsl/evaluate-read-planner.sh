#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/common.sh"
require_root

SOURCE_ROOT="${1:?Falta la ruta fuente del proyecto.}"
CLIENT_SLUG="${2:-piloto-odoo19}"
MODEL_NAME="${3:-gpt-5.6-terra}"
LIMIT="${4:-80}"
CASE_IDS="${5:-}"
ENFORCE="${6:-False}"

[[ "$CLIENT_SLUG" =~ ^[a-z0-9][a-z0-9-]{1,62}$ ]] || { echo "ClientSlug inválido." >&2; exit 1; }
[[ "$MODEL_NAME" =~ ^[A-Za-z0-9._-]+$ ]] || { echo "Model inválido." >&2; exit 1; }
[[ "$LIMIT" =~ ^[0-9]+$ ]] && (( LIMIT >= 1 && LIMIT <= 80 )) || { echo "Limit debe estar entre 1 y 80." >&2; exit 1; }
[[ -z "$CASE_IDS" || "$CASE_IDS" =~ ^[A-Za-z0-9,]+$ ]] || { echo "CaseIds inválido." >&2; exit 1; }

set -a
source "$SERVICE_ENV"
set +a

ARGS=(scripts/evaluate-read-planner.js --client "$CLIENT_SLUG" --model "$MODEL_NAME" --limit "$LIMIT")
[[ -n "$CASE_IDS" ]] && ARGS+=(--case "$CASE_IDS")
[[ "$ENFORCE" == "True" ]] && ARGS+=(--enforce)

cd "$RUNTIME_ROOT/control-api"
runuser -u "$SERVICE_USER" --preserve-environment -- "$NODE_HOME/bin/node" "${ARGS[@]}"
