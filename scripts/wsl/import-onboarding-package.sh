#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/common.sh"
require_root

SOURCE_ROOT="${1:?Falta la ruta fuente del proyecto.}"
ACTION="${2:?Falta preview o apply.}"
PACKAGE_PATH="${3:?Falta el paquete.}"
EXPECTED_HASH="${4:-}"
PRIVATE_KEY="/root/.config/odoo-ai-agent/onboarding-private.pem"

[[ "$ACTION" == "preview" || "$ACTION" == "apply" ]] || {
  echo "Acción inválida." >&2
  exit 2
}
[[ -f "$PRIVATE_KEY" ]] || {
  echo "No existe la clave privada. Ejecute Initialize-OnboardingKeys-Wsl.ps1." >&2
  exit 2
}
[[ -f "$PACKAGE_PATH" ]] || {
  echo "No existe el paquete indicado." >&2
  exit 2
}
[[ -f "$SERVICE_ENV" ]] || {
  echo "No existe el entorno protegido del servicio." >&2
  exit 2
}

set -a
# shellcheck disable=SC1090
source "$SERVICE_ENV"
set +a

arguments=(
  "$RUNTIME_ROOT/control-api/src/onboarding-cli.js"
  "$ACTION"
  --package "$PACKAGE_PATH"
  --private-key "$PRIVATE_KEY"
)
if [[ "$ACTION" == "apply" ]]; then
  arguments+=(--expected-hash "$EXPECTED_HASH")
fi
"$NODE_HOME/bin/node" "${arguments[@]}"

