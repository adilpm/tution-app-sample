#!/bin/sh
# Nightly SQLite backup. Safe while the app is running (uses SQLite's backup API).
# Install: sudo crontab -u tuition -e  and add:
#   30 2 * * * /opt/tuition/deploy/backup.sh
set -eu

DB=/opt/tuition/data/tuition.db
DEST=/opt/tuition/backups
KEEP_DAYS=30

mkdir -p "$DEST"
STAMP=$(date +%F)
sqlite3 "$DB" ".backup '$DEST/tuition-$STAMP.db'"
gzip -f "$DEST/tuition-$STAMP.db"
find "$DEST" -name 'tuition-*.db.gz' -mtime +"$KEEP_DAYS" -delete

# Strongly recommended: copy backups OFF this server, e.g. with rclone to Google Drive:
#   rclone copy "$DEST" gdrive:tuition-backups --max-age 2d
