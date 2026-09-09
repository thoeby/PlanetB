#!/usr/bin/env bash
# WP5.5 — /jobs holds what an atom uploaded on its way to a published tile
# (ARCHITECTURE §7). Once the job is done and nobody has touched it for a week
# those bytes are nobody's input any more, and this deletes them.
#
#     set -a; . ./.env; set +a
#     bash tools/gc-jobs.sh              # says what it would delete, deletes nothing
#     bash tools/gc-jobs.sh --apply      # deletes it
#     bash tools/gc-jobs.sh --days 30    # a wider window
#
# The dangerous mistake is deleting bytes something still points at, and the
# reason it is easy to make is dedup: an artifact is written once (Invariant 1),
# so an atom that computes bytes another atom already uploaded cannot put them
# under its own directory and records the older path instead
# (client/js/work.js elsewhere(), client/js/inputs.js). A live job's input can
# therefore sit in a dead job's directory. Deleting it is unrecoverable — the
# sha is registered, so can_write refuses to let anyone upload it again.
#
# Safe to run against a working world: it is a dry run unless told otherwise,
# every candidate is re-checked against the database in the same statement that
# authorises the delete, and nothing whose file was touched inside the window is
# a candidate at all.
set -euo pipefail

FILES_ROOT=${FILES_ROOT:-./infra/files}
DB=${PGDATABASE:-splatworld}
DAYS=${GC_DAYS:-7}
APPLY=

while [ $# -gt 0 ]; do
    case $1 in
        --apply) APPLY=1 ;;
        --days) shift; DAYS=${1:?--days needs a number} ;;
        *) sed -n '2,10p' "$0" >&2; exit 1 ;;
    esac
    shift
done

[ -d "$FILES_ROOT/jobs" ] || { echo "gc-jobs: no $FILES_ROOT/jobs, nothing to do"; exit 0; }

# Files, not directories: a directory may hold one artifact a live job still
# needs and one nobody does, and only the second is ours.
candidates () {
    find "$FILES_ROOT/jobs" -mindepth 2 -maxdepth 2 -type f \
        -mmin +$((DAYS * 1440)) -printf '%P\n' | sort
}

gc_sql () {
    sed "s/@DAYS@/$DAYS/g" <<'SQL'
WITH parsed AS (
    SELECT c.rel,
        split_part(c.rel, '/', 1)::bigint AS atom_id,
        split_part(split_part(c.rel, '/', 2), '.', 1) AS sha,
        '/jobs/' || c.rel AS path
    FROM candidate c WHERE c.rel ~ '^[0-9]+/'
),
-- recheck_atom() puts a settled job back to 'open' (db/0015_structural.sql),
-- so "done" is read here and now, in the statement that decides the delete,
-- and never remembered from a previous pass.
settled AS (
    SELECT j.id FROM job j
    WHERE j.state = 'done'
      AND j.created_at < now() - make_interval(days => @DAYS@)
      AND NOT EXISTS (
          SELECT 1 FROM atom a WHERE a.job_id = j.id
            AND greatest(a.claimed_at, a.heartbeat_at)
                > now() - make_interval(days => @DAYS@))
),
live AS (
    SELECT a.id, a.result, a.output_sha256 FROM atom a
    WHERE a.job_id NOT IN (SELECT s.id FROM settled s)
),
live_file AS (
    SELECT l.id, f FROM live l,
        LATERAL jsonb_array_elements(coalesce(l.result -> 'files', '[]'::jsonb)) AS f
),
-- A path a live atom names is not this directory's to delete, whoever's
-- directory it is: that is the dedup case in the header comment.
kept_path AS (
    SELECT l.result ->> 'path' AS path FROM live l
    WHERE l.result ->> 'path' IS NOT null
    UNION SELECT lf.f ->> 'path' FROM live_file lf WHERE lf.f ->> 'path' IS NOT null
    UNION SELECT '/jobs/' || l.id || '/' || l.output_sha256 FROM live l
    WHERE l.output_sha256 IS NOT null
),
-- And bytes a pointer still names survive wherever they sit: a published tile
-- and a catalog asset must not lose theirs to a neighbouring job's cleanup.
kept_sha AS (
    SELECT l.output_sha256 AS sha FROM live l WHERE l.output_sha256 IS NOT null
    UNION SELECT lf.f ->> 'sha' FROM live_file lf WHERE lf.f ->> 'sha' IS NOT null
    UNION SELECT t.sog_sha256 FROM tile t WHERE t.sog_sha256 IS NOT null
    UNION SELECT t.manifest -> 'height' ->> 'sha256' FROM tile t
    WHERE t.manifest -> 'height' ->> 'sha256' IS NOT null
    UNION SELECT t.manifest -> 'colliders' ->> 'sha256' FROM tile t
    WHERE t.manifest -> 'colliders' ->> 'sha256' IS NOT null
    UNION SELECT s.sha256 FROM asset s
    UNION SELECT s.thumb_sha256 FROM asset s WHERE s.thumb_sha256 IS NOT null
)
SELECT 'del ' || p.rel
FROM parsed p
JOIN atom ax ON ax.id = p.atom_id
WHERE ax.job_id IN (SELECT s.id FROM settled s)
  AND p.path NOT IN (SELECT k.path FROM kept_path k)
  AND p.sha NOT IN (SELECT k.sha FROM kept_sha k)
UNION ALL
-- No atom row owns these. tools/test-tiles.sh clears them after a db-reset;
-- this tool will not, because bytes whose atom is gone may still be the only
-- copy of an artifact somebody registered.
SELECT DISTINCT 'orphan ' || p.atom_id
FROM parsed p
WHERE NOT EXISTS (SELECT 1 FROM atom a WHERE a.id = p.atom_id)
ORDER BY 1
SQL
}

plan () {
    {
        echo 'CREATE TEMP TABLE candidate (rel text);'
        echo '\copy candidate (rel) FROM stdin'
        candidates
        echo '\.'
        gc_sql
    } | psql -v ON_ERROR_STOP=1 --no-psqlrc -q -t -A -d "$DB"
}

report () { # $1 = plan file
    local bytes=0 rel
    while read -r _ rel; do
        bytes=$((bytes + $(stat -c%s "$FILES_ROOT/jobs/$rel" 2>/dev/null || echo 0)))
    done < <(grep '^del ' "$1" || true)
    echo "gc-jobs: $(grep -c '^del ' "$1" || true) file(s), $bytes byte(s)," \
         "in jobs done and untouched for $DAYS day(s)"
    grep '^orphan ' "$1" | sed 's/^orphan /gc-jobs: no atom row for jobs\//' || true
}

PLAN=$(mktemp)
trap 'rm -f "$PLAN"' EXIT
plan > "$PLAN"
report "$PLAN"

if [ -z "$APPLY" ]; then
    grep '^del ' "$PLAN" | sed 's|^del |  would delete /jobs/|' || true
    echo 'gc-jobs: dry run, nothing deleted. Pass --apply.'
    exit 0
fi

# A second, fresh plan: between the report above and here a tab may have
# claimed a recheck and re-opened a job, and only this snapshot may authorise
# a delete.
plan > "$PLAN"
dirs=$(mktemp); trap 'rm -f "$PLAN" "$dirs"' EXIT
n=0
while read -r _ rel; do
    rm -f "$FILES_ROOT/jobs/$rel"
    dirname "$rel" >> "$dirs"
    n=$((n + 1))
done < <(grep '^del ' "$PLAN" || true)
sort -u "$dirs" | while read -r d; do
    rmdir "$FILES_ROOT/jobs/$d" 2> /dev/null || true
done
echo "gc-jobs: deleted $n file(s)"
