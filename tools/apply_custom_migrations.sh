#!/bin/sh
# tools/apply_custom_migrations.sh
# Nakama's `nakama migrate up` only manages Nakama's own schema.
# Custom tables (Volume 1/2 §5) are applied separately with this script.
#
# Usage: ./tools/apply_custom_migrations.sh
# Requires: psql client, and the postgres container already up
# (docker compose up -d).

set -e

DB_HOST="${DB_HOST:-localhost}"
DB_PORT="${DB_PORT:-5432}"
DB_USER="${DB_USER:-nakama}"
DB_PASSWORD="${DB_PASSWORD:-localdev}"
DB_NAME="${DB_NAME:-nakama}"

for f in "$(dirname "$0")"/../postgres/migrations/*.sql; do
  echo "Applying $f ..."
  PGPASSWORD="$DB_PASSWORD" psql "postgresql://${DB_USER}@${DB_HOST}:${DB_PORT}/${DB_NAME}?sslmode=disable" -f "$f"
done

echo "Done."
