#!/usr/bin/env bash
# =============================================================================
# Converge — DB reset
# =============================================================================
# Drops the database referenced by DATABASE_URL, recreates it, and applies
# prisma/sql/schema.sql. Then regenerates the Prisma client.
#
# Usage:
#   ./scripts/db-reset.sh           # interactive (prompts before dropping)
#   ./scripts/db-reset.sh --force   # non-interactive (CI / scripted use)
#
# Requirements:
#   - .env with a valid DATABASE_URL (mysql://user:pass@host:port/db)
#   - Either:
#       * the docker container started by ./start-database.sh is running, OR
#       * a local `mysql` client that can reach the host:port from DATABASE_URL
# =============================================================================

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCHEMA_FILE="$ROOT_DIR/prisma/sql/schema.sql"
SEED_FILE="$ROOT_DIR/prisma/sql/seed.sql"
ENV_FILE="$ROOT_DIR/.env"

FORCE=0
if [[ "${1:-}" == "--force" || "${1:-}" == "-f" ]]; then
  FORCE=1
fi

if [[ ! -f "$SCHEMA_FILE" ]]; then
  echo "Error: $SCHEMA_FILE not found." >&2
  exit 1
fi

# Prefer DATABASE_URL from the environment (set by the devcontainer compose);
# fall back to the .env file for the native-host workflow.
if [[ -z "${DATABASE_URL:-}" ]]; then
  if [[ ! -f "$ENV_FILE" ]]; then
    echo "Error: DATABASE_URL not set and $ENV_FILE not found. Copy .env.example to .env first." >&2
    exit 1
  fi
  DATABASE_URL="$(grep -E '^DATABASE_URL=' "$ENV_FILE" | tail -n1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//")"
fi

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "Error: DATABASE_URL is empty (checked env and $ENV_FILE)." >&2
  exit 1
fi

# Parse mysql://USER:PASS@HOST:PORT/DBNAME
parse() { echo "$DATABASE_URL" | sed -E "s|^mysql://([^:]+):([^@]+)@([^:/]+):([0-9]+)/([^?]+).*|\\$1|"; }
urldecode() { local s="${1//+/ }"; printf '%b' "${s//%/\\x}"; }
DB_USER="$(urldecode "$(echo "$DATABASE_URL" | sed -E 's|^mysql://([^:]+):.*|\1|')")"
DB_PASS="$(urldecode "$(echo "$DATABASE_URL" | sed -E 's|^mysql://[^:]+:([^@]+)@.*|\1|')")"
DB_HOST="$(echo "$DATABASE_URL" | sed -E 's|^mysql://[^:]+:[^@]+@([^:/]+):.*|\1|')"
DB_PORT="$(echo "$DATABASE_URL" | sed -E 's|^mysql://[^:]+:[^@]+@[^:]+:([0-9]+)/.*|\1|')"
DB_NAME="$(echo "$DATABASE_URL" | sed -E 's|^mysql://[^:]+:[^@]+@[^:]+:[0-9]+/([^?]+).*|\1|')"

if [[ -z "$DB_NAME" ]]; then
  echo "Error: could not parse database name from DATABASE_URL." >&2
  exit 1
fi

echo "Target:   $DB_USER@$DB_HOST:$DB_PORT/$DB_NAME"
echo "Schema:   $SCHEMA_FILE"

if [[ $FORCE -ne 1 ]]; then
  echo
  echo "This will DROP database '$DB_NAME' and recreate it from schema.sql."
  read -r -p "Continue? [y/N]: " REPLY
  if [[ ! "$REPLY" =~ ^[Yy]$ ]]; then
    echo "Aborted."
    exit 1
  fi
fi

# -----------------------------------------------------------------------------
# Pick the mysql runner: prefer the running docker container, fall back to a
# locally installed mysql client.
# -----------------------------------------------------------------------------
DB_CONTAINER="$DB_NAME-mysql"
RUNNER=""

pick_docker_cmd() {
  if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    echo "docker"
  elif command -v podman >/dev/null 2>&1 && podman info >/dev/null 2>&1; then
    echo "podman"
  fi
}

DOCKER_CMD="$(pick_docker_cmd || true)"

if [[ -n "$DOCKER_CMD" ]] && [[ -n "$($DOCKER_CMD ps -q -f name="^${DB_CONTAINER}$" 2>/dev/null)" ]]; then
  RUNNER="docker"
  echo "Runner:   $DOCKER_CMD exec $DB_CONTAINER"
elif command -v mysql >/dev/null 2>&1; then
  RUNNER="local"
  echo "Runner:   local mysql client"
else
  echo "Error: no mysql runner available." >&2
  echo "Start the dev DB with ./start-database.sh, or install the mysql CLI." >&2
  exit 1
fi

run_sql() {
  # $1 = SQL string. Always runs against the server (no DB selected).
  if [[ "$RUNNER" == "docker" ]]; then
    "$DOCKER_CMD" exec -i "$DB_CONTAINER" \
      mysql -u"$DB_USER" -p"$DB_PASS" -e "$1"
  else
    mysql -h "$DB_HOST" -P "$DB_PORT" -u "$DB_USER" -p"$DB_PASS" -e "$1"
  fi
}

run_file() {
  # $1 = file path. Runs against $DB_NAME.
  if [[ "$RUNNER" == "docker" ]]; then
    "$DOCKER_CMD" exec -i "$DB_CONTAINER" \
      mysql -u"$DB_USER" -p"$DB_PASS" "$DB_NAME" < "$1"
  else
    mysql -h "$DB_HOST" -P "$DB_PORT" -u "$DB_USER" -p"$DB_PASS" "$DB_NAME" < "$1"
  fi
}

echo
echo "Dropping and recreating database '$DB_NAME'..."
run_sql "DROP DATABASE IF EXISTS \`$DB_NAME\`; CREATE DATABASE \`$DB_NAME\` DEFAULT CHARACTER SET utf8mb4;"

echo "Applying schema.sql..."
run_file "$SCHEMA_FILE"

if [[ -f "$SEED_FILE" ]]; then
  echo "Applying seed.sql..."
  run_file "$SEED_FILE"
fi

# Reference data (e.g. the geo_* location master list) lives in idempotent
# *_data.sql migrations because schema.sql only carries structure.
for f in "$ROOT_DIR"/prisma/sql/migrations/*_data.sql; do
  [[ -f "$f" ]] || continue
  echo "Loading reference data $(basename "$f")..."
  run_file "$f"
done

echo "Regenerating Prisma client..."
( cd "$ROOT_DIR" && npx prisma generate )

echo
echo "Done. Database '$DB_NAME' has been reset."
