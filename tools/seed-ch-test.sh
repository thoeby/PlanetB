#!/usr/bin/env bash
# WP5.1 — the region seed's gate. Asserts what tools/seed-ch.sh does before it
# writes anything (the plan, and what it says when a source is out of reach),
# then seeds a small region end to end and asserts the world it leaves behind.
#
# It works in a scratch database and a scratch file store of its own, both
# dropped on the way out. Seeding a region writes areas and tile rows, and a
# dirty tile row nobody has published is a hole in the viewer's ground
# (docs/pilot.md) — the shared world is not the place to find out whether the
# orchestration works. That also keeps it clear of tools/seed-test.sh, which
# asserts exact area counts in $PGDATABASE.
#
# The geo and OSM halves skip, rather than fail, where the sources cannot be
# reached — the same rule tools/seed-test.sh follows.
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=tools/geo-common.sh
. tools/geo-common.sh

PASS=0
FAIL=0
ok () { echo "ok - $1"; PASS=$((PASS + 1)); }
no () { echo "not ok - $1"; FAIL=$((FAIL + 1)); }
is () { [ "$2" = "$3" ] && ok "$1" || no "$1 (expected $2, got $3)"; }
q () { $PSQL_Q -c "$1"; }

# A region that holds every feature of the pilot fixture, and one z14 tile of it.
BOX=8.02,47.375,8.07,47.40
BOXSQL="st_makeenvelope(${BOX//,/, }, 4326)"
TILE_Z=14; TILE_X=$((PILOT_X * 16 + 8)); TILE_Y=$((PILOT_Y * 16 + 8))
read -r tw ts te tn <<< "$(geo_lonlat_bounds $TILE_Z $TILE_X $TILE_Y)"
ONE=$(awk -v w="$tw" -v s="$ts" -v e="$te" -v n="$tn" 'BEGIN {
    d = (e - w) / 100;   # inside the tile, so a shared edge pulls in no neighbour
    printf "%.9f,%.9f,%.9f,%.9f\n", w + d, s + d, e - d, n - d }')

# ------------------------------------------------------------------- scratch

SCRATCH_DB=splatworld_seedch_$$
export FILES_ROOT; FILES_ROOT=$(mktemp -d)
export GEO_CACHE_EMPTY; GEO_CACHE_EMPTY=$(mktemp -d)
cleanup () {
    PGDATABASE=postgres $PSQL_Q -c "DROP DATABASE IF EXISTS $SCRATCH_DB WITH (FORCE)" > /dev/null
    # db/0007_api.sql sets the authenticator's password, and a role is
    # cluster-wide: applying the migrations anywhere sets it everywhere. Put it
    # back on the way out, or a scratch run with a different environment leaves
    # the developer's own PostgREST unable to log in.
    PGDATABASE=postgres $PSQL_Q -c "ALTER ROLE authenticator PASSWORD '${AUTHENTICATOR_PASSWORD:-authenticator}'" > /dev/null 2>&1 || true
    rm -rf "$FILES_ROOT" "$GEO_CACHE_EMPTY"
}
PGDATABASE=postgres $PSQL_Q -c "SELECT 1" > /dev/null 2>&1 \
    || { echo "not ok - no database at ${PGHOST:-localhost}:${PGPORT:-5432}"; exit 1; }
PGDATABASE=postgres $PSQL_Q -c "CREATE DATABASE $SCRATCH_DB" > /dev/null
trap cleanup EXIT
export PGDATABASE=$SCRATCH_DB
$PSQL_Q -c "ALTER DATABASE $SCRATCH_DB SET app.jwt_secret = '${JWT_SECRET:-dev}'" > /dev/null
$PSQL_Q -c 'CREATE EXTENSION IF NOT EXISTS postgis' \
    -c 'CREATE EXTENSION IF NOT EXISTS pgcrypto' > /dev/null
for f in $(ls db/[0-9]*.sql | sort); do
    psql -v ON_ERROR_STOP=1 --no-psqlrc -q -v authpw="${AUTHENTICATOR_PASSWORD:-authenticator}" \
        -v geopw="${GEOSERVER_DB_PASSWORD:-geoserver}" -f "$f" > /dev/null 2>&1 \
        || { echo "not ok - $f would not apply to $SCRATCH_DB"; exit 1; }
done
echo "# seed-ch-test: $SCRATCH_DB, store $FILES_ROOT"

# --------------------------------------------------------------------- plan

# What the checked-in outline covers is arithmetic: the plan must be the same
# number tiles_for_geom gives, or the disk budget in docs/seed-ch.md is fiction.
ch_z14=$(q "SELECT count(*) FROM tiles_for_geom(
    st_geomfromgeojson(\$g\$$(cat infra/seed/ch.geojson)\$g\$), 14, 14)")
plan=$(DRY_RUN=1 bash tools/seed-ch.sh)
is "the plan's z14 count is the outline's own" "$ch_z14" \
    "$(sed -n 's/^# seed-ch:   z14: \([0-9]*\) tiles$/\1/p' <<< "$plan")"
[ "$ch_z14" -gt 13000 ] && [ "$ch_z14" -lt 18000 ] \
    && ok "and Switzerland is ~14 k z14 tiles ($ch_z14)" \
    || no "and Switzerland is ~14 k z14 tiles (got $ch_z14)"
grep -q 'dry run, nothing written' <<< "$plan" && ok "a dry run says so" || no "a dry run says so"
is "and writes nothing" 0 "$(q "SELECT count(*) FROM area")"

# BBOX is the override that runs one canton without an outline file for it.
is "BBOX plans the same tiles as a polygon of the same corners" \
    "$(q "SELECT count(*) FROM tiles_for_geom($BOXSQL, 14, 14)")" \
    "$(DRY_RUN=1 BBOX=$BOX bash tools/seed-ch.sh \
        | sed -n 's/^# seed-ch:   z14: \([0-9]*\) tiles$/\1/p')"
BBOX=8.02,47.375 bash tools/seed-ch.sh > /dev/null 2>&1 \
    && no "half a BBOX is refused" || ok "half a BBOX is refused"

# ------------------------------------------------------------- missing source

# Never half-seed silently: a source that cannot be reached stops the run before
# the first write, and the message names what to fetch and where to put it.
out=$(SEED_OSM=1 GEO_CACHE=$GEO_CACHE_EMPTY \
    OSM_URL=https://geofabrik.invalid/ch.osm.pbf bash tools/seed-ch.sh 2>&1) \
    && no "an unreachable OSM extract stops the run" \
    || ok "an unreachable OSM extract stops the run"
grep -q 'geofabrik.invalid' <<< "$out" && grep -q "$GEO_CACHE_EMPTY" <<< "$out" \
    && ok "and names the file to fetch and where to put it" \
    || no "and names the file to fetch and where to put it (said: $out)"

out=$(SEED_GEO=1 DEM_SRC=/nonexistent.tif bash tools/seed-ch.sh 2>&1) \
    && no "a country-sized region with no ortho mosaic stops the run" \
    || ok "a country-sized region with no ortho mosaic stops the run"
grep -q 'ORTHO_SRC' <<< "$out" && ok "and says to set ORTHO_SRC" || no "and says to set ORTHO_SRC"
is "and nothing was written by either" 0 "$(q "SELECT count(*) FROM area")"

# ---------------------------------------------------------- areas and tiles

BBOX=$BOX SEED_NAME=seedchtest bash tools/seed-ch.sh > /dev/null
is "one system area per z12 tile of the region, detail 14" \
    "$(q "SELECT count(*) FROM tiles_for_geom($BOXSQL, 12, 12)")" \
    "$(q "SELECT count(*) FROM area WHERE rules ->> 'seed' = 'seedchtest' AND detail = 14")"
is "owned by the seed user" 1 \
    "$(q "SELECT count(DISTINCT a.owner_id) FROM area a
          JOIN auth.user u ON u.id = a.owner_id AND u.email = '$SEED_EMAIL'")"
is "every z14 tile of the region is dirty at version 1" \
    "$(q "SELECT count(*) FROM tiles_for_geom($BOXSQL, 14, 14)")" \
    "$(q "SELECT count(*) FROM tile WHERE z = 14 AND dirty AND expected_version = 1")"
is "and there are rows at every zoom from 6 to 14" "6,8,10,12,14" \
    "$(q "SELECT string_agg(z::text, ',' ORDER BY z) FROM (SELECT DISTINCT z FROM tile) AS zs")"

# The acceptance criterion: a job can be opened on what the seed dirtied.
job=$(q "SELECT ensure_job(t.z, t.x, t.y) FROM (SELECT set_config('request.jwt.claims',
        json_build_object('sub', (SELECT id FROM auth.user WHERE email = '$SEED_EMAIL'),
            'role', 'admin')::text, true)) AS c,
        (SELECT z, x, y FROM tile WHERE z = 14 AND dirty ORDER BY x, y LIMIT 1) AS t")
[ "${job:-0}" -gt 0 ] && ok "a job opens on a dirty z14 tile" \
    || no "a job opens on a dirty z14 tile"
is "and it is the baseline DAG, not a trained one" "assemble,sample,sog" \
    "$(q "SELECT string_agg(DISTINCT op, ',' ORDER BY op) FROM atom WHERE job_id = ${job:-0}")"

BBOX=$BOX SEED_NAME=seedchtest bash tools/seed-ch.sh > /dev/null
is "seeding the region twice adds no second area" \
    "$(q "SELECT count(*) FROM tiles_for_geom($BOXSQL, 12, 12)")" \
    "$(q "SELECT count(*) FROM area")"
is "and does not bump a tile it already knows" 1 \
    "$(q "SELECT max(expected_version) FROM tile")"

# ------------------------------------------------------------------ rasters

# One z14 tile, read off AWS open data over range requests the way
# tools/seed-test.sh does — enough to prove the orchestration, not a seed.
dem=$(geo_store_path dem $TILE_Z $TILE_X $TILE_Y r16)
if BBOX=$ONE SEED_GEO=1 REGION_MIN_Z=14 REGION_MAX_Z=14 DEM_STREAM=1 ORTHO_STREAM=1 \
    bash tools/seed-ch.sh > /dev/null 2>&1; then
    is "the region seed cuts a z14 dem tile into its own store" 131072 "$(stat -c%s "$dem")"
    is "and registers it" "dem|dem-v1" \
        "$(q "SELECT kind || '|' || algo_version FROM artifact
              WHERE sha256 = '$(sha256sum "$dem" | cut -d' ' -f1)'")"
    # PROGRESS deviation 71: a store ahead of the database is brought level by
    # re-running, not by FORCE. Losing the row must not lose the tile.
    q "DELETE FROM artifact WHERE kind = 'dem'" > /dev/null
    BBOX=$ONE SEED_GEO=1 REGION_MIN_Z=14 REGION_MAX_Z=14 DEM_STREAM=1 ORTHO_STREAM=1 \
        bash tools/seed-ch.sh > /dev/null 2>&1
    is "a re-run registers a tile it had already cut" 1 \
        "$(q "SELECT count(*) FROM artifact WHERE kind = 'dem'")"
    is "and cut it only once" 1 "$(find "$FILES_ROOT/geo/dem" -type f | wc -l)"
else
    echo "# seed-ch-test: the DEM or ortho source is unreachable, raster assertions skipped"
fi

# --------------------------------------------------------------------- osm

if command -v osm2pgsql > /dev/null; then
    BBOX=$BOX SEED_NAME=seedchtest OSM_FILE=infra/seed/pilot-fixture.osm \
        bash tools/seed-ch.sh > /dev/null
    is "the region seed puts the fixture's features in the world" 7 \
        "$(q "SELECT count(*) FROM feature WHERE props ? 'osm'")"
    is "one row per OSM id, not one per overlapping area" 7 \
        "$(q "SELECT count(DISTINCT props ->> 'osm') FROM feature WHERE props ? 'osm'")"
    is "and every area of the region remembers the extract" 0 \
        "$(q "SELECT count(*) FROM area a
              JOIN tiles_for_geom($BOXSQL, 12, 12) AS t
                  ON a.rules ->> 'z12' = t.x || '/' || t.y
              WHERE NOT a.rules ? 'osm_extract'")"
    out=$(BBOX=$BOX SEED_NAME=seedchtest OSM_FILE=infra/seed/pilot-fixture.osm \
        bash tools/seed-ch.sh)
    grep -q 'already seeded from' <<< "$out" \
        && ok "a second run skips the extract it has already read" \
        || no "a second run skips the extract it has already read"
    is "and the world still holds 7 features" 7 \
        "$(q "SELECT count(*) FROM feature WHERE props ? 'osm'")"
else
    echo "# seed-ch-test: osm2pgsql is not installed, OSM assertions skipped"
fi

echo "# $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
