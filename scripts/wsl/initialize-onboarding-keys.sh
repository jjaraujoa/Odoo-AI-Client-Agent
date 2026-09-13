#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/common.sh"
require_root

SOURCE_ROOT="${1:?Falta la ruta fuente del proyecto.}"
PRIVATE_DIR="/root/.config/odoo-ai-agent"
PRIVATE_KEY="$PRIVATE_DIR/onboarding-private.pem"
PUBLIC_PEM="$SOURCE_ROOT/onboarding/consultant-kit/platform-public-key.pem"
PUBLIC_JSON="$SOURCE_ROOT/onboarding/consultant-kit/platform-public-key.json"

install -d -o root -g root -m 700 "$PRIVATE_DIR"
install -d -m 755 "$SOURCE_ROOT/onboarding/consultant-kit"

if [[ ! -f "$PRIVATE_KEY" ]]; then
  openssl genpkey -algorithm RSA \
    -pkeyopt rsa_keygen_bits:3072 \
    -out "$PRIVATE_KEY"
  chmod 600 "$PRIVATE_KEY"
fi

openssl pkey -in "$PRIVATE_KEY" -pubout -out "$PUBLIC_PEM"
key_id="$(openssl pkey -pubin -in "$PUBLIC_PEM" -outform DER \
  | openssl dgst -sha256 -binary | xxd -p -c 256)"
"$NODE_HOME/bin/node" "$SOURCE_ROOT/scripts/export-onboarding-public-key.mjs" \
  "$PUBLIC_PEM" "$key_id" >"$PUBLIC_JSON"
chmod 644 "$PUBLIC_PEM" "$PUBLIC_JSON"

echo "Clave privada protegida en $PRIVATE_KEY"
echo "Kit público actualizado en $SOURCE_ROOT/onboarding/consultant-kit"

