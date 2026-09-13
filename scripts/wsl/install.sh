#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/common.sh"
require_root

SOURCE_ROOT="${1:?Falta la ruta fuente del proyecto.}"
ENV_FILE="$SOURCE_ROOT/.env"
if [[ ! -f "$ENV_FILE" ]]; then
  echo "No existe $ENV_FILE. Ejecute Initialize-Pilot.ps1 primero." >&2
  exit 1
fi

echo "Instalando dependencias del sistema..."
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends \
  ca-certificates curl xz-utils clamav clamav-daemon

systemctl enable --now postgresql

if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  useradd --system --create-home --home-dir "/var/lib/$SERVICE_USER" \
    --shell /usr/sbin/nologin "$SERVICE_USER"
fi
usermod -a -G clamav "$SERVICE_USER"

install -d -o "$SERVICE_USER" -g "$SERVICE_USER" \
  "$RUNTIME_ROOT" \
  "$RUNTIME_ROOT/control-api" \
  "$RUNTIME_ROOT/n8n" \
  "$RUNTIME_ROOT/n8n/workflows" \
  "$RUNTIME_ROOT/db/migrations" \
  "$RUNTIME_ROOT/workflows" \
  "$RUNTIME_ROOT/data/n8n" \
  "$RUNTIME_ROOT/logs"

if [[ ! -x "$NODE_HOME/bin/node" ]] || \
   [[ "$("$NODE_HOME/bin/node" --version)" != "v$NODE_VERSION" ]]; then
  echo "Instalando Node.js v$NODE_VERSION desde nodejs.org..."
  temp_dir="$(mktemp -d)"
  trap 'rm -rf "$temp_dir"' EXIT
  curl --fail --silent --show-error --location \
    --output "$temp_dir/node.tar.xz" \
    "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-x64.tar.xz"
  curl --fail --silent --show-error --location \
    --output "$temp_dir/SHASUMS256.txt" \
    "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt"
  expected="$(awk '/ node-v'"$NODE_VERSION"'-linux-x64.tar.xz$/ {print $1}' \
    "$temp_dir/SHASUMS256.txt")"
  actual="$(sha256sum "$temp_dir/node.tar.xz" | awk '{print $1}')"
  if [[ -z "$expected" || "$actual" != "$expected" ]]; then
    echo "La suma SHA-256 de Node.js no coincide." >&2
    exit 1
  fi
  rm -rf "$NODE_HOME"
  mkdir -p "$NODE_HOME"
  tar -xJf "$temp_dir/node.tar.xz" --strip-components=1 -C "$NODE_HOME"
  chown -R root:root "$NODE_HOME"
  trap - EXIT
  rm -rf "$temp_dir"
fi

echo "Sincronizando la aplicación..."
cp -a "$SOURCE_ROOT/control-api/." "$RUNTIME_ROOT/control-api/"
cp -a "$SOURCE_ROOT/n8n/workflows/." "$RUNTIME_ROOT/workflows/"
cp -a "$SOURCE_ROOT/n8n/workflows/." "$RUNTIME_ROOT/n8n/workflows/"
cp -a "$SOURCE_ROOT/db/migrations/." "$RUNTIME_ROOT/db/migrations/"
cp "$SOURCE_ROOT/.env.example" "$RUNTIME_ROOT/.env.example"
chown -R "$SERVICE_USER:$SERVICE_USER" \
  "$RUNTIME_ROOT/control-api" \
  "$RUNTIME_ROOT/n8n" \
  "$RUNTIME_ROOT/db" \
  "$RUNTIME_ROOT/workflows" \
  "$RUNTIME_ROOT/.env.example" \
  "$RUNTIME_ROOT/data" \
  "$RUNTIME_ROOT/logs"

echo "Instalando dependencias Node.js..."
run_as_agent "$NODE_HOME/bin/npm" --prefix "$RUNTIME_ROOT/control-api" \
  install --omit=dev --no-audit --no-fund

if [[ ! -f "$RUNTIME_ROOT/n8n/package.json" ]]; then
  cat >"$RUNTIME_ROOT/n8n/package.json" <<'JSON'
{
  "name": "odoo-ai-agent-n8n-runtime",
  "private": true,
  "dependencies": {
    "n8n": "2.30.5"
  }
}
JSON
  chown "$SERVICE_USER:$SERVICE_USER" "$RUNTIME_ROOT/n8n/package.json"
fi
run_as_agent "$NODE_HOME/bin/npm" --prefix "$RUNTIME_ROOT/n8n" \
  install --omit=dev --no-audit --no-fund

POSTGRES_DB="$(read_env_value "$ENV_FILE" POSTGRES_DB)"
POSTGRES_USER="$(read_env_value "$ENV_FILE" POSTGRES_USER)"
POSTGRES_PASSWORD="$(read_env_value "$ENV_FILE" POSTGRES_PASSWORD)"
validate_identifier "$POSTGRES_DB" "POSTGRES_DB"
validate_identifier "$POSTGRES_USER" "POSTGRES_USER"
if [[ ! "$POSTGRES_PASSWORD" =~ ^[A-Fa-f0-9]{32,128}$ ]]; then
  echo "POSTGRES_PASSWORD debe ser hexadecimal y haber sido generado por el inicializador." >&2
  exit 1
fi

echo "Preparando una base PostgreSQL independiente..."
if ! runuser -u postgres -- psql -tAc \
  "SELECT 1 FROM pg_roles WHERE rolname='$POSTGRES_USER'" | grep -q 1; then
  runuser -u postgres -- createuser "$POSTGRES_USER"
fi
runuser -u postgres -- psql -v ON_ERROR_STOP=1 -c \
  "ALTER ROLE \"$POSTGRES_USER\" WITH LOGIN PASSWORD '$POSTGRES_PASSWORD';"
if ! runuser -u postgres -- psql -tAc \
  "SELECT 1 FROM pg_database WHERE datname='$POSTGRES_DB'" | grep -q 1; then
  runuser -u postgres -- createdb --owner="$POSTGRES_USER" "$POSTGRES_DB"
fi

bash "$SCRIPT_DIR/apply-migrations.sh" "$SOURCE_ROOT"

echo "Preparando el archivo de entorno protegido..."
{
  grep -E '^[A-Z_][A-Z0-9_]*=' "$ENV_FILE"
  echo "DATABASE_URL=postgresql://$POSTGRES_USER:$POSTGRES_PASSWORD@127.0.0.1:5432/$POSTGRES_DB"
  echo "PORT=8080"
  echo "CLAMAV_SOCKET=/run/clamav/clamd.ctl"
  echo "CLAMAV_HOST=127.0.0.1"
  echo "CLAMAV_PORT=3310"
  echo "DB_TYPE=postgresdb"
  echo "DB_POSTGRESDB_HOST=127.0.0.1"
  echo "DB_POSTGRESDB_PORT=5432"
  echo "DB_POSTGRESDB_DATABASE=$POSTGRES_DB"
  echo "DB_POSTGRESDB_USER=$POSTGRES_USER"
  echo "DB_POSTGRESDB_PASSWORD=$POSTGRES_PASSWORD"
  echo "DB_POSTGRESDB_SCHEMA=n8n"
  echo "N8N_HOST=localhost"
  echo "N8N_LISTEN_ADDRESS=0.0.0.0"
  echo "N8N_PORT=5678"
  echo "N8N_PROTOCOL=http"
  echo "N8N_EDITOR_BASE_URL=http://localhost:5678"
  echo "N8N_WEBHOOK_URL=$(read_env_value "$ENV_FILE" N8N_WEBHOOK_URL)"
  echo "N8N_USER_FOLDER=$RUNTIME_ROOT/data/n8n"
  echo "N8N_DEFAULT_BINARY_DATA_MODE=filesystem"
  echo "N8N_DIAGNOSTICS_ENABLED=false"
  echo "N8N_PERSONALIZATION_ENABLED=false"
  echo "N8N_TEMPLATES_ENABLED=false"
  echo "N8N_UNVERIFIED_PACKAGES_ENABLED=false"
  echo "N8N_RUNNERS_TASK_TIMEOUT=60"
  echo "N8N_COMPRESSION_NODE_MAX_DECOMPRESSED_SIZE_BYTES=268435456"
  echo "N8N_COMPRESSION_NODE_MAX_ZIP_ENTRIES=1000"
  echo "N8N_BLOCK_ENV_ACCESS_IN_NODE=true"
  echo "N8N_BLOCK_FILE_ACCESS_TO_N8N_FILES=true"
  echo "N8N_ENFORCE_SETTINGS_FILE_PERMISSIONS=true"
  echo "N8N_ENFORCE_GLOBAL_USER_AGENT=true"
  echo "N8N_SECURE_COOKIE=false"
  echo "EXECUTIONS_DATA_SAVE_ON_SUCCESS=none"
  echo "EXECUTIONS_DATA_SAVE_ON_ERROR=all"
  echo "EXECUTIONS_DATA_PRUNE=true"
  echo "EXECUTIONS_DATA_MAX_AGE=168"
} >"$SERVICE_ENV"
chmod 600 "$SERVICE_ENV"
chown root:root "$SERVICE_ENV"

cat >/etc/systemd/system/$CONTROL_SERVICE <<UNIT
[Unit]
Description=Odoo AI Agent - Control API
After=network-online.target postgresql.service clamav-daemon.service
Wants=network-online.target

[Service]
Type=simple
User=$SERVICE_USER
Group=$SERVICE_USER
SupplementaryGroups=clamav
WorkingDirectory=$RUNTIME_ROOT/control-api
EnvironmentFile=$SERVICE_ENV
Environment=PATH=$NODE_HOME/bin:/usr/local/bin:/usr/bin:/bin
Environment=HOME=/var/lib/$SERVICE_USER
ExecStart=$NODE_HOME/bin/node src/server.js
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=$RUNTIME_ROOT /var/lib/$SERVICE_USER

[Install]
WantedBy=multi-user.target
UNIT

cat >/etc/systemd/system/$N8N_SERVICE <<UNIT
[Unit]
Description=Odoo AI Agent - n8n
After=network-online.target postgresql.service $CONTROL_SERVICE
Wants=network-online.target

[Service]
Type=simple
User=$SERVICE_USER
Group=$SERVICE_USER
WorkingDirectory=$RUNTIME_ROOT/n8n
EnvironmentFile=$SERVICE_ENV
Environment=PATH=$NODE_HOME/bin:/usr/local/bin:/usr/bin:/bin
Environment=HOME=/var/lib/$SERVICE_USER
ExecStart=$RUNTIME_ROOT/n8n/node_modules/.bin/n8n start
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=$RUNTIME_ROOT /var/lib/$SERVICE_USER

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable postgresql clamav-freshclam clamav-daemon \
  "$CONTROL_SERVICE" "$N8N_SERVICE"
systemctl restart clamav-freshclam || true
systemctl restart clamav-daemon

echo ""
echo "Instalación nativa WSL completada."
echo "Inicie con scripts/Start-Pilot-Wsl.ps1."
