#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/common.sh"
require_root

SOURCE_ROOT="${1:?Falta la ruta fuente del proyecto.}"
ENV_FILE="$SOURCE_ROOT/.env"
MIGRATIONS_DIR="$SOURCE_ROOT/db/migrations"

POSTGRES_DB="$(read_env_value "$ENV_FILE" POSTGRES_DB)"
POSTGRES_USER="$(read_env_value "$ENV_FILE" POSTGRES_USER)"
POSTGRES_PASSWORD="$(read_env_value "$ENV_FILE" POSTGRES_PASSWORD)"
validate_identifier "$POSTGRES_DB" "POSTGRES_DB"
validate_identifier "$POSTGRES_USER" "POSTGRES_USER"

export PGPASSWORD="$POSTGRES_PASSWORD"
for migration in "$MIGRATIONS_DIR"/*.sql; do
  version="$(basename "$migration" .sql)"
  registry="$(psql -h 127.0.0.1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc \
    "SELECT to_regclass('agent.schema_migrations')" 2>/dev/null || true)"
  if [[ -n "$registry" ]]; then
    applied="$(psql -h 127.0.0.1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc \
      "SELECT 1 FROM agent.schema_migrations WHERE version = '$version'" 2>/dev/null || true)"
    if [[ "$applied" == "1" ]]; then
      echo "Omitiendo $(basename "$migration"): ya aplicada."
      continue
    fi
  fi
  echo "Aplicando $(basename "$migration")..."
  psql -v ON_ERROR_STOP=1 -h 127.0.0.1 -U "$POSTGRES_USER" \
    -d "$POSTGRES_DB" -f "$migration"
done
unset PGPASSWORD
echo "Migraciones aplicadas."
