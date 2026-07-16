#!/usr/bin/env bash
# Nightly backup: pg_dump of the database + uploaded files, archived with
# 30-day retention. Run from cron on the host, e.g.:
#   0 2 * * * /opt/p2p-app/deploy/backup.sh >> /var/log/p2p-backup.log 2>&1
set -euo pipefail

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(dirname "$DEPLOY_DIR")"
ARCHIVE_DIR="$APP_DIR/backups"
RETENTION_DAYS=30
STAMP="$(date +%Y%m%d-%H%M%S)"

mkdir -p "$ARCHIVE_DIR" "$APP_DIR/data/backups"

# 1. consistent database dump via the postgres container
docker compose -f "$DEPLOY_DIR/docker-compose.yml" exec -T postgres \
  pg_dump -U p2p --clean --if-exists p2p | gzip > "$APP_DIR/data/backups/p2p-$STAMP.sql.gz"

# 2. archive the dump + invoice uploads + vendor KYC documents + branding
tar -czf "$ARCHIVE_DIR/p2p-backup-$STAMP.tar.gz" -C "$APP_DIR/data" backups uploads vendor-docs branding

# 3. prune local dumps and archives
find "$APP_DIR/data/backups" -name 'p2p-*.sql.gz' -mtime +"$RETENTION_DAYS" -delete
find "$ARCHIVE_DIR" -name 'p2p-backup-*.tar.gz' -mtime +"$RETENTION_DAYS" -delete

echo "$(date -Iseconds) backup complete: $ARCHIVE_DIR/p2p-backup-$STAMP.tar.gz"

# To RESTORE a dump:
#   gunzip -c p2p-YYYYMMDD-HHMMSS.sql.gz | \
#     docker compose -f deploy/docker-compose.yml exec -T postgres psql -U p2p p2p

# 4. OFFSITE COPY — uncomment and configure exactly one. Backups contain bank
#    details and invoices: use a private, encrypted bucket.
# rclone copy "$ARCHIVE_DIR/p2p-backup-$STAMP.tar.gz" remote:p2p-backups/
# aws s3 cp "$ARCHIVE_DIR/p2p-backup-$STAMP.tar.gz" "s3://YOUR-BUCKET/p2p-backups/" --sse AES256
