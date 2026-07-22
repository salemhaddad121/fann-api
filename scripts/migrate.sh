#!/usr/bin/env bash
#
# Applies migrations/*.sql in numeric order, stopping at the first error.
#
#   npm run migrate
#
# Reads DB_* from .env if present (env vars already set win). Each file runs
# in a single transaction via ON_ERROR_STOP, so a failure leaves nothing
# half-applied for that file.
#
# Note: these are plain .sql files with no applied-migrations tracking table,
# so this is intended for building a fresh database (or re-running a file you
# know is idempotent) — not for incremental production deploys.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIGRATIONS_DIR="$ROOT/migrations"

if [ -f "$ROOT/.env" ]; then
  # Only pull the DB_* keys through; ignore comments and blank lines.
  while IFS='=' read -r key value; do
    case "$key" in
      DB_HOST|DB_PORT|DB_NAME|DB_USER|DB_PASSWORD)
        # Don't clobber a value already exported in the environment.
        if [ -z "${!key:-}" ]; then export "$key=$value"; fi
        ;;
    esac
  done < <(grep -E '^[[:space:]]*DB_[A-Z_]+=' "$ROOT/.env" | sed 's/^[[:space:]]*//')
fi

DB_HOST="${DB_HOST:-localhost}"
DB_PORT="${DB_PORT:-5432}"
DB_NAME="${DB_NAME:-fann}"
DB_USER="${DB_USER:-postgres}"
DB_PASSWORD="${DB_PASSWORD:-}"

command -v psql >/dev/null 2>&1 || {
  echo "error: psql not found on PATH — install the postgresql client." >&2
  exit 1
}

echo "Applying migrations to $DB_USER@$DB_HOST:$DB_PORT/$DB_NAME"

shopt -s nullglob
files=("$MIGRATIONS_DIR"/*.sql)
if [ ${#files[@]} -eq 0 ]; then
  echo "error: no .sql files found in $MIGRATIONS_DIR" >&2
  exit 1
fi

for file in "${files[@]}"; do
  name="$(basename "$file")"
  printf '  %-45s' "$name"
  if PGPASSWORD="$DB_PASSWORD" psql \
      --host="$DB_HOST" --port="$DB_PORT" \
      --username="$DB_USER" --dbname="$DB_NAME" \
      --quiet --no-psqlrc --single-transaction \
      --set ON_ERROR_STOP=1 --file="$file" > /tmp/fann-migrate.log 2>&1; then
    echo "ok"
  else
    echo "FAILED"
    echo
    cat /tmp/fann-migrate.log >&2
    exit 1
  fi
done

echo "All ${#files[@]} migrations applied."
