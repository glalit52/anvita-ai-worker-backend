#!/usr/bin/env bash
# Restore a backup made by scripts/backup.sh into DATABASE_URL.
#
#   DATABASE_URL=postgres://…/anvita_staging scripts/restore.sh backups/anvita-20261113T020000Z.dump
#
# The target database's existing objects are dropped first (--clean). Refuses to run against a
# database whose name ends in "prod" unless CONFIRM_PROD=yes. Stop the API and workers first.
set -euo pipefail

FILE="${1:?usage: scripts/restore.sh <backup file (.dump or .dump.gpg)>}"
: "${DATABASE_URL:?DATABASE_URL is required}"
DB_NAME="$(basename "${DATABASE_URL%%\?*}")"
if [[ "$DB_NAME" == *prod* && "${CONFIRM_PROD:-}" != "yes" ]]; then
  echo "Refusing to restore into '$DB_NAME' without CONFIRM_PROD=yes" >&2
  exit 1
fi

if [[ "$FILE" == *.gpg ]]; then
  PLAIN="$(mktemp)"
  trap 'rm -f "$PLAIN"' EXIT
  gpg --batch --yes --decrypt --output "$PLAIN" "$FILE"
  FILE="$PLAIN"
fi

echo "→ restoring into $DB_NAME"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "CREATE EXTENSION IF NOT EXISTS vector" 2>/dev/null || echo "  (pgvector not available — knowledge search will be keyword-only)"
pg_restore --clean --if-exists --no-owner --no-privileges --exit-on-error --dbname="$DATABASE_URL" "$FILE"
echo "✓ restored. Start the API: it applies any newer migrations on boot (MIGRATE_ON_START)."
echo "  The tenant role (anvita_tenant) grants are re-applied by migration 0009 on a fresh cluster."
