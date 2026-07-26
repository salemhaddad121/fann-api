#!/usr/bin/env bash
#
# Applies migrations/*.sql in filename order, tracking what has already run
# in a schema_migrations table so this is safe to run repeatedly and safe
# for incremental deploys.
#
#   npm run migrate
#
# Reads DB_* from .env if present (env vars already set win). Each file runs
# in a single transaction via ON_ERROR_STOP, so a failure leaves nothing
# half-applied for that file, and the file is only recorded as applied once
# it has actually succeeded.
#
# BASELINING
# ----------
# A database that predates this script has migrations applied but no
# schema_migrations table. Running every file again could be destructive, so
# this script refuses to guess: on a non-empty database with no tracking
# table it stops and asks for MIGRATE_BASELINE=1, which records the current
# files as already-applied WITHOUT executing them.
#
# Only baseline when you know the files on disk match what the database
# already has. If a migration is on disk but has NOT been applied, baselining
# will skip it permanently.

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
MIGRATE_BASELINE="${MIGRATE_BASELINE:-0}"

command -v psql >/dev/null 2>&1 || {
  echo "error: psql not found on PATH — install the postgresql client." >&2
  exit 1
}

export PGPASSWORD="$DB_PASSWORD"
psql_q() {
  psql --host="$DB_HOST" --port="$DB_PORT" --username="$DB_USER" --dbname="$DB_NAME" \
       --quiet --no-psqlrc --tuples-only --no-align --set ON_ERROR_STOP=1 -c "$1"
}

echo "Applying migrations to $DB_USER@$DB_HOST:$DB_PORT/$DB_NAME"

shopt -s nullglob
files=("$MIGRATIONS_DIR"/*.sql)
if [ ${#files[@]} -eq 0 ]; then
  echo "error: no .sql files found in $MIGRATIONS_DIR" >&2
  exit 1
fi

# ---------------------------------------------------------------- tracking
tracking_exists="$(psql_q "SELECT to_regclass('public.schema_migrations') IS NOT NULL")"

if [ "$tracking_exists" != "t" ]; then
  # A populated database with no tracking table is the pre-existing case.
  schema_exists="$(psql_q "SELECT to_regclass('public.users') IS NOT NULL")"

  if [ "$schema_exists" = "t" ] && [ "$MIGRATE_BASELINE" != "1" ]; then
    cat >&2 <<'MSG'

error: this database already has a schema but no schema_migrations table.

Re-running every migration could be destructive, so nothing has been done.
If the files in migrations/ match what this database already has, record
them as applied without executing them:

    MIGRATE_BASELINE=1 npm run migrate

If instead this database is missing some of those migrations, apply the
missing ones by hand first, then baseline.

MSG
    exit 1
  fi

  psql_q "CREATE TABLE schema_migrations (
            filename   text PRIMARY KEY,
            checksum   text NOT NULL,
            applied_at timestamptz NOT NULL DEFAULT now(),
            baselined  boolean NOT NULL DEFAULT false
          )" > /dev/null
  echo "  created schema_migrations"

  if [ "$schema_exists" = "t" ]; then
    echo "  BASELINING — recording existing files as applied without running them:"
    for file in "${files[@]}"; do
      name="$(basename "$file")"
      sum="$(sha256sum "$file" | cut -d' ' -f1)"
      psql_q "INSERT INTO schema_migrations (filename, checksum, baselined)
              VALUES ('$name', '$sum', true)" > /dev/null
      echo "      baselined $name"
    done
    echo "  Baseline complete. Verify these really were applied to this database."
    exit 0
  fi
fi

# ---------------------------------------------------------------- apply
applied=0
skipped=0

for file in "${files[@]}"; do
  name="$(basename "$file")"
  sum="$(sha256sum "$file" | cut -d' ' -f1)"
  known="$(psql_q "SELECT checksum FROM schema_migrations WHERE filename = '$name'")"

  if [ -n "$known" ]; then
    if [ "$known" != "$sum" ]; then
      # Not fatal: the file already ran, so the database reflects the old
      # content. Loud, because it means the repo and the database disagree.
      echo "  ! $name changed since it was applied — database has the OLD version"
    fi
    skipped=$((skipped + 1))
    continue
  fi

  printf '  %-45s' "$name"
  if psql --host="$DB_HOST" --port="$DB_PORT" --username="$DB_USER" --dbname="$DB_NAME" \
          --quiet --no-psqlrc --single-transaction \
          --set ON_ERROR_STOP=1 --file="$file" > /tmp/fann-migrate.log 2>&1; then
    psql_q "INSERT INTO schema_migrations (filename, checksum) VALUES ('$name', '$sum')" > /dev/null
    echo "ok"
    applied=$((applied + 1))
  else
    echo "FAILED"
    echo
    cat /tmp/fann-migrate.log >&2
    exit 1
  fi
done

echo "Done — $applied applied, $skipped already present."
