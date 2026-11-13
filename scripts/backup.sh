#!/usr/bin/env bash
# Logical backup of the Anvita database (pg_dump custom format), optionally uploaded to S3 or GCS
# and pruned. Run it from cron, a Kubernetes CronJob (deploy/k8s/backup-cronjob.yaml) or by hand.
#
#   DATABASE_URL=postgres://… scripts/backup.sh
#
# Env:
#   DATABASE_URL       required
#   BACKUP_DIR         local folder (default ./backups)
#   BACKUP_URI         optional: s3://bucket/prefix or gs://bucket/prefix (needs aws / gsutil)
#   BACKUP_KEEP_DAYS   local files older than this are deleted (default 14)
#   BACKUP_GPG_RECIPIENT optional: encrypt the dump to this GPG key before upload
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$BACKUP_DIR"
FILE="$BACKUP_DIR/anvita-$STAMP.dump"

echo "→ dumping to $FILE"
# --no-owner/--no-privileges keep restores portable between environments (staging ← prod copies).
pg_dump --format=custom --compress=9 --no-owner --no-privileges --file="$FILE" "$DATABASE_URL"
pg_restore --list "$FILE" > /dev/null # fails if the archive is unreadable

if [[ -n "${BACKUP_GPG_RECIPIENT:-}" ]]; then
  gpg --batch --yes --encrypt --recipient "$BACKUP_GPG_RECIPIENT" --output "$FILE.gpg" "$FILE"
  rm -f "$FILE"
  FILE="$FILE.gpg"
fi
echo "✓ $(du -h "$FILE" | cut -f1) $FILE"

if [[ -n "${BACKUP_URI:-}" ]]; then
  case "$BACKUP_URI" in
    s3://*) aws s3 cp --only-show-errors "$FILE" "${BACKUP_URI%/}/$(basename "$FILE")" ;;
    gs://*) gsutil -q cp "$FILE" "${BACKUP_URI%/}/$(basename "$FILE")" ;;
    *) echo "BACKUP_URI must start with s3:// or gs://" >&2; exit 1 ;;
  esac
  echo "✓ uploaded to ${BACKUP_URI%/}/$(basename "$FILE")"
fi

find "$BACKUP_DIR" -name 'anvita-*.dump*' -type f -mtime "+$KEEP_DAYS" -print -delete
