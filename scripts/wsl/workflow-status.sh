#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/common.sh"
require_root

database="$(read_env_value "$SERVICE_ENV" DB_POSTGRESDB_DATABASE)"
validate_identifier "$database" "DB_POSTGRESDB_DATABASE"
runuser -u postgres -- psql --dbname="$database" --tuples-only --no-align \
  --field-separator='|' \
  --command="SELECT w.name,
                    w.active,
                    EXISTS (
                      SELECT 1
                      FROM jsonb_array_elements(w.nodes::jsonb) AS node
                      WHERE node->'credentials'->'httpHeaderAuth'->>'name' = 'Control API Internal'
                    ) AS internal_credential_assigned
             FROM n8n.workflow_entity AS w
             ORDER BY w.name;"
runuser -u postgres -- psql --dbname="$database" --tuples-only --no-align \
  --field-separator='|' \
  --command="SELECT 'CREDENCIAL', name, type FROM n8n.credentials_entity ORDER BY name;"
