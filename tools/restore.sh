#!/usr/bin/env bash
# WP5.5 — the other half of tools/backup.sh, and the drift check you reach for
# when you suspect the two halves have come apart.
#
#     set -a; . ./.env; set +a
#     bash tools/restore.sh <backup-dir> [--force]   # into $PGDATABASE/$FILES_ROOT
#     bash tools/restore.sh <backup-dir> --files-only # put missing bytes back
#     bash tools/restore.sh --check                  # report drift, restore nothing
#
# It is a script and not three lines of runbook prose because the order is the
# whole point and the order is the thing a human gets wrong at three in the
# morning: the bytes go back first, the database second. A database restored
# ahead of the store names artifacts the store does not have yet, and every tab
# that claims an atom in that window fails to resolve its inputs; the other way
# round the store merely holds bytes nothing points at, which is harmless.
#
# What the dump does not carry, and this script therefore re-applies:
#   * app.jwt_secret — a per-database setting (ALTER DATABASE … SET), which
#     pg_dump never writes. Without it auth.sign() raises and nobody can log in.
#   * the anon/player/admin/authenticator roles and every p_<id> player login,
#     which are cluster objects. On a fresh cluster create them first;
#     docs/runbook.md says how.
set -euo pipefail

FILES_ROOT=${FILES_ROOT:-./infra/files}
DB=${PGDATABASE:-splatworld}
PSQL="psql -v ON_ERROR_STOP=1 --no-psqlrc -q -t -A"

# ------------------------------------------------------------------ drift
# The paths the database says the store must hold. Everything else in the store
# is either intermediate (/jobs, see tools/gc-jobs.sh) or addressed by tile
# coordinates rather than by hash (/geo), and is re-cuttable by the seeds.
named_paths () {
    $PSQL -d "$DB" <<'SQL'
SELECT '/tiles/' || t.z || '/' || t.x || '/' || t.y || '/' || t.sog_sha256 || '.sog'
FROM tile t WHERE t.sog_sha256 IS NOT null
UNION ALL
SELECT '/tiles/' || t.z || '/' || t.x || '/' || t.y || '/'
    || (t.manifest -> 'height' ->> 'sha256') || '.r16'
FROM tile t WHERE t.manifest -> 'height' ->> 'sha256' IS NOT null
UNION ALL
SELECT '/tiles/' || t.z || '/' || t.x || '/' || t.y || '/'
    || (t.manifest -> 'colliders' ->> 'sha256') || '.json'
FROM tile t WHERE t.manifest -> 'colliders' ->> 'sha256' IS NOT null
UNION ALL
SELECT '/assets/' || a.sha256 || '.glb' FROM asset a
UNION ALL
SELECT '/assets/' || a.thumb_sha256 || '.webp'
FROM asset a WHERE a.thumb_sha256 IS NOT null
SQL
}

# Rows without bytes are fatal — nothing can supply those bytes again, because
# can_write refuses a registered sha256. Bytes without rows are only litter.
drift_report () {
    local missing=0 total=0 p extra named shas
    # A database that cannot be read is the worst thing this can find, not a
    # world with nothing in it: read it into a variable so psql's exit status
    # is visible at all, because a process substitution hides it and the report
    # would say "0 of them missing" about a server that is down.
    named=$($PSQL -d "$DB" -c 'SELECT 1' > /dev/null 2>&1 && named_paths) || {
        echo "drift: cannot read $DB at ${PGHOST:-localhost}:${PGPORT:-5432}\
 — nothing was checked" >&2
        return 2
    }
    while read -r p; do
        [ -n "$p" ] || continue
        total=$((total + 1))
        if [ ! -f "$FILES_ROOT$p" ]; then
            missing=$((missing + 1))
            [ "$missing" -le 20 ] && echo "  missing bytes: $p"
        fi
    done <<< "$named"
    shas=$($PSQL -d "$DB" -c 'SELECT sha256 FROM artifact ORDER BY sha256') || return 2
    extra=$(comm -23 <(store_shas) <(printf '%s\n' "$shas") | wc -l)
    echo "drift: $total paths named by $DB, $missing of them missing from $FILES_ROOT"
    echo "drift: $extra file(s) in the store that no artifact row knows about"
    [ "$missing" -eq 0 ]
}

store_shas () {
    find "$FILES_ROOT/assets" "$FILES_ROOT/tiles" -type f -printf '%f\n' 2>/dev/null \
        | sed 's/\..*$//' | grep -E '^[0-9a-f]{64}$' | sort -u
}

# ------------------------------------------------------------------ restore
# Invariant 1 again: only ever fill in, never overwrite. rsync where there is
# one, cp where there is not (tools/backup.sh says why that case is normal).
copy_into () { # src-dir dest-dir
    # Whoever runs this is not the nginx worker that writes the store: a
    # directory created here must stay writable by it, as the root is (1777).
    mkdir -p "$2"; chmod 1777 "$2" 2>/dev/null || true
    if command -v rsync > /dev/null; then rsync -a --ignore-existing "$1" "$2/"; return; fi
    if cp --help 2>&1 | grep -q -- --update; then cp -a --update=none "$1." "$2/"
    else cp -an "$1." "$2/"; fi
}

restore_files () {
    local src=$1 d
    for d in "$src"/files/*/; do
        [ -d "$d" ] || continue
        # Invariant 1: a path already in the store holds the bytes its name says
        # it holds, so a restore never overwrites — it only fills in.
        copy_into "$d" "$FILES_ROOT/$(basename "$d")"
        echo "restore: files $(basename "$d")"
    done
}

# pg_restore wants an empty database: run into one that already has the schema
# and it reports hundreds of "already exists" errors and exits non-zero, which
# under `set -e` would take the jwt_secret and the drift report down with it.
# So an existing database is dropped and recreated, and --force is what says
# that may happen — to a database with rows in it, and to a freshly migrated
# empty one, because both would fail the same way.
restore_db () {
    local src=$1 force=$2 rows tables
    if $PSQL -d postgres -c \
        "SELECT 1 FROM pg_database WHERE datname = '$DB'" | grep -q 1; then
        rows=$($PSQL -d "$DB" -c \
            "SELECT count(*) FROM artifact" 2>/dev/null || echo 0)
        tables=$($PSQL -d "$DB" -c "SELECT count(*) FROM pg_tables
            WHERE schemaname NOT IN ('pg_catalog', 'information_schema')" 2>/dev/null || echo 0)
        if [ "$tables" != "0" ] && [ "$force" != "--force" ]; then
            echo "restore: $DB already holds $tables table(s) and $rows artifact row(s);\
 pass --force to drop and rebuild it" >&2
            exit 1
        fi
        if [ "$tables" != "0" ]; then
            $PSQL -d postgres -c "DROP DATABASE \"$DB\" WITH (FORCE)" > /dev/null
            echo "restore: dropped $DB ($tables table(s), $rows artifact row(s))"
        fi
    fi
    if ! $PSQL -d postgres -c \
        "SELECT 1 FROM pg_database WHERE datname = '$DB'" | grep -q 1; then
        createdb "$DB"
        echo "restore: created $DB"
    fi
    # PostGIS and pgcrypto are extensions, not dump content: a dump made on a
    # box that had them restores their objects and not the extensions.
    $PSQL -d "$DB" -c 'CREATE EXTENSION IF NOT EXISTS postgis' \
        -c 'CREATE EXTENSION IF NOT EXISTS pgcrypto' > /dev/null
    pg_restore --dbname="$DB" --no-owner "$src/db.dump"
    # Not in the dump: a per-database GUC. db/0002_auth.sql refuses to mint a
    # token without it, so a restore that skips this looks like "login is broken".
    if [ -n "${JWT_SECRET:-}" ]; then
        # psql interpolates :'…' in a script, not in -c, and this is the one
        # place a stray quote in the secret would be an injection.
        $PSQL -d postgres -v d="$DB" -v s="$JWT_SECRET" -f - > /dev/null <<'SQL'
ALTER DATABASE :"d" SET app.jwt_secret = :'s';
SQL
        echo "restore: app.jwt_secret re-applied from \$JWT_SECRET"
    else
        echo "restore: JWT_SECRET unset — set app.jwt_secret by hand or logins fail" >&2
    fi
}

# --------------------------------------------------------------------- main
case "${1:-}" in
    --check)
        drift_report
        ;;
    '' | -h | --help)
        sed -n '2,8p' "$0" >&2
        exit 1
        ;;
    *)
        SRC=$1
        [ -d "$SRC/files" ] || { echo "restore: no files/ in $SRC" >&2; exit 1; }
        mkdir -p "$FILES_ROOT"
        restore_files "$SRC"
        # The usual repair: the database is fine and the store has lost bytes,
        # which --check reports as "missing bytes". Only the store is touched.
        if [ "${2:-}" != "--files-only" ]; then
            [ -f "$SRC/db.dump" ] || { echo "restore: no db.dump in $SRC" >&2; exit 1; }
            restore_db "$SRC" "${2:-}"
        fi
        drift_report
        ;;
esac
