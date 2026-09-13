#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/common.sh"
require_root

systemctl --no-pager --full status \
  postgresql clamav-daemon "$CONTROL_SERVICE" "$N8N_SERVICE" || true
echo
ss -lntp | grep -E ':(5432|5678|8080)[[:space:]]' || true
echo
curl --fail --silent --show-error http://127.0.0.1:8080/health || true
echo
