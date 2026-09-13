#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/common.sh"
require_root

systemctl start postgresql clamav-freshclam clamav-daemon
systemctl restart "$CONTROL_SERVICE" "$N8N_SERVICE"

for _ in $(seq 1 30); do
  if curl --fail --silent http://127.0.0.1:8080/health >/dev/null; then
    break
  fi
  sleep 1
done

systemctl --no-pager --full status "$CONTROL_SERVICE" "$N8N_SERVICE" \
  | sed -n '1,35p'
curl --fail --silent --show-error http://127.0.0.1:8080/health
echo
