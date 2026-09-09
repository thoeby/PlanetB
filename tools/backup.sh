#!/usr/bin/env bash
# WP5.5 — a backup of this world is both halves or it is nothing: the database
# that names the bytes, and the bytes themselves.
#
#     set -a; . ./.env; set +a
#     bash tools/backup.sh [dest-root]        # default ./backups
#
# The order is load-bearing. Every writer here puts the bytes down before the
# row that names them: client/js/work.js PUTs and then calls register_artifact,
# tools/seed-dem.sh cuts a tile and then calls geo_register. So a dump taken
# *before* the file copy can only name artifacts whose bytes were already on
# disk when the copy started, and the worst drift a backup can contain is bytes
# nothing names yet — litter. Copy the files first and the dump names artifacts
# written after the copy: rows without bytes, which are not recoverable at all,
# because can_write refuses a second PUT of a registered sha256
# (db/0008_files.sql) and nothing can ever supply those bytes again.
#
# /geo and /jobs are deliberately not copied. /geo is re-cuttable by
# tools/seed-dem.sh and tools/seed-ortho.sh, which re-register what is already
# on disk and are idempotent either way; /jobs is intermediate and is what
# tools/gc-jobs.sh deletes. docs/runbook.md says what that costs you.
set -euo pipefail

DEST_ROOT=${1:-${BACKUP_ROOT:-./backups}}
FILES_ROOT=${FILES_ROOT:-./infra/files}
DB=${PGDATABASE:-splatworld}
DIRS=${BACKUP_DIRS:-assets tiles}
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
DEST=$DEST_ROOT/$STAMP

command -v pg_dump > /dev/null || { echo "backup: no pg_dump on PATH" >&2; exit 1; }
[ -d "$FILES_ROOT" ] || { echo "backup: no file store at $FILES_ROOT" >&2; exit 1; }

mkdir -p "$DEST/files"
DEST_ABS=$(cd "$DEST" && pwd)

# ---------------------------------------------------------------- the database
echo "backup: pg_dump $DB -> $DEST/db.dump"
pg_dump --format=custom --compress=6 --file="$DEST/db.dump" "$DB"
# When the dump finished, taken here rather than from the file's mtime: rsync
# and cp both preserve the source's, so a copied file's mtime says nothing about
# when it was copied. The manifest carries both stamps and tools/ops-test.sh
# asserts the order from them, so swapping these two blocks fails the gate.
DUMP_AT=$(date -u +%s%N)

# ------------------------------------------------------------------- the bytes
# An artifact is content-addressed and never rewritten (Invariant 1), so a path
# that exists in the previous backup holds the same bytes it did then: every run
# after the first is hard links against the last and costs only what is new.
prev=$(find "$DEST_ROOT" -mindepth 1 -maxdepth 1 -type d ! -name "$STAMP" \
       | sort | tail -1)
link=()
if [ -n "$prev" ] && [ -d "$prev/files" ]; then
    link=(--link-dest="$(cd "$prev/files" && pwd)")
    echo "backup: hard-linking unchanged files against $prev"
fi

# rsync where there is one. Where there is not — a container with pg_dump and
# no rsync is a normal place to take a backup from — cp does the same two
# things by hand: hard-link last night's tree, then copy in what is new
# without rewriting a link. --update=none is what makes the second half safe.
copy_dir () { # dir
    if command -v rsync > /dev/null; then
        rsync -a "${link[@]}" "$FILES_ROOT/$1" "$DEST/files/"
        return
    fi
    if [ -n "$prev" ] && [ -d "$prev/files/$1" ]; then
        cp -al "$prev/files/$1" "$DEST/files/"
    fi
    mkdir -p "$DEST/files/$1"
    if cp --help 2>&1 | grep -q -- --update; then
        cp -a --update=none "$FILES_ROOT/$1/." "$DEST/files/$1/"
    else
        cp -an "$FILES_ROOT/$1/." "$DEST/files/$1/"
    fi
}

for d in $DIRS; do
    if [ ! -d "$FILES_ROOT/$d" ]; then
        echo "backup: $FILES_ROOT/$d does not exist, skipped"
        continue
    fi
    copy_dir "$d"
    echo "backup: copied $d"
done
FILES_AT=$(date -u +%s%N)

# ---------------------------------------------------------------- the manifest
# What was taken, in which order, and from where — a restore that has to guess
# any of that is a restore nobody will attempt at three in the morning.
{
    printf '%-14s %s\n' stamp "$STAMP"
    printf '%-14s %s\n' database "$DB @ ${PGHOST:-localhost}:${PGPORT:-5432}"
    printf '%-14s %s\n' files_root "$(cd "$FILES_ROOT" && pwd)"
    printf '%-14s %s\n' dirs "$DIRS"
    printf '%-14s %s\n' order 'pg_dump first, then the files'
    printf '%-14s %s\n' dump_at "$DUMP_AT"
    printf '%-14s %s\n' files_at "$FILES_AT"
    printf '%-14s %s\n' dump_bytes "$(stat -c%s "$DEST/db.dump")"
    for d in $DIRS; do
        [ -d "$DEST/files/$d" ] || continue
        printf '%-14s %s\n' "$d.files" "$(find "$DEST/files/$d" -type f | wc -l)"
        printf '%-14s %s\n' "$d.bytes" "$(du -sb "$DEST/files/$d" | cut -f1)"
    done
    printf '%-14s %s\n' git \
        "$(git -C "$(dirname "$0")/.." rev-parse --short HEAD 2>/dev/null || echo unknown)"
} > "$DEST/manifest.txt"

cat "$DEST/manifest.txt"
echo "backup: $DEST_ABS"
echo "backup: restore with  FILES_ROOT=… PGDATABASE=… bash tools/restore.sh $DEST"
