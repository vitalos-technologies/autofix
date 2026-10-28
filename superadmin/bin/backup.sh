#!/usr/bin/env sh
# Nightly logical backup: pg_dump (custom format) into $BACKUP_DIR, keeping $BACKUP_RETENTION_DAYS days.
# Only expired dump files in the backup directory are ever deleted; the database is read-only here.
set -eu
: "${DATABASE_URL:?DATABASE_URL must be set}"
DIR="${BACKUP_DIR:-/backups}"
DAYS="${BACKUP_RETENTION_DAYS:-14}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
FILE="$DIR/autofix-superadmin-$STAMP.dump"

mkdir -p "$DIR"
# Only the app's schema (public): on Supabase, the platform schemas (auth, storage, ...) must not be
# restored over a new project's own.
pg_dump --format=custom --schema=public --no-owner --no-privileges --dbname="$DATABASE_URL" --file="$FILE.partial"
mv "$FILE.partial" "$FILE"
pg_restore --list "$FILE" > /dev/null  # fail loudly if the archive is unreadable
# -mtime +N matches files at least N+1 days old, so this keeps exactly $DAYS daily dumps.
find "$DIR" -maxdepth 1 -type f -name 'autofix-superadmin-*.dump' -mtime +"$((DAYS - 1))" -delete
printf '{"event": "backup_complete", "file": "%s", "bytes": %s, "retention_days": %s}\n' \
  "$(basename "$FILE")" "$(wc -c < "$FILE" | tr -d ' ')" "$DAYS"
