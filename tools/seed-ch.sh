#!/usr/bin/env bash
# WP5.1 — seeds Switzerland: one system area per z12 tile of the country
# (detail 14), the z6…z14 tile rows those areas promise to draw, and — when the
# sources are within reach — the terrain, imagery and OSM behind them.
#
#     set -a; . ./.env; set +a
#     bash tools/seed-ch.sh                                   # areas and tiles
#     SEED_GEO=1 bash tools/seed-ch.sh                        # ... and rasters
#     OSM_FILE=switzerland-latest.osm.pbf bash tools/seed-ch.sh   # ... and OSM
#     DRY_RUN=1 bash tools/seed-ch.sh                         # what it would do
#
# The region is a polygon, not a tile: infra/seed/ch.geojson, and any other
# outline works the same way (REGION_GEOJSON). BBOX=west,south,east,north seeds
# a rectangle instead, which is how one canton is run without an outline for it.
# Sizes, timings, disk and what each source costs are in docs/seed-ch.md.
#
# Every source is checked before anything is written, and a missing one names
# the file to fetch and where to put it. Half a country in the store and nothing
# in the database is the state this refuses to reach: it is what PROGRESS
# deviation 71 cost once already. Interrupt it anywhere and run the same command
# again — the raster seeds skip and re-register what they have already cut, and
# the OSM pass is skipped once every area of the region carries the signature of
# the extract it was seeded from.
#
# Dev-box tooling. The server executes no compute (Invariant 9): this cuts
# inputs into the immutable file store and records them, and every splat is
# still drawn in a browser.
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=tools/geo-common.sh
. tools/geo-common.sh

export REGION_GEOJSON=${REGION_GEOJSON:-infra/seed/ch.geojson}
export REGION_MIN_Z=${REGION_MIN_Z:-6}
export REGION_MAX_Z=${REGION_MAX_Z:-14}
SEED_NAME=${SEED_NAME:-ch}
GEO_ROOT_Z=${GEO_ROOT_Z:-10}
OSM_URL=${OSM_URL:-https://download.geofabrik.de/europe/switzerland-latest.osm.pbf}
COP_BASE=${COP_BASE:-https://copernicus-dem-30m.s3.amazonaws.com}
S2_BASE=${S2_BASE:-https://sentinel-cogs.s3.us-west-2.amazonaws.com}
S2_SQUARE=${S2_SQUARE:-32/T/MT}
export CURL_CA_BUNDLE=${CURL_CA_BUNDLE:-/etc/ssl/certs/ca-certificates.crt}

work=$(mktemp -d); trap 'rm -rf "$work"' EXIT
die () { echo "not ok - $1" >&2; exit 1; }
say () { echo "# seed-ch: $*"; }
hms () { printf '%dh%02dm%02ds' $(($1 / 3600)) $(($1 % 3600 / 60)) $(($1 % 60)); }
want_osm () { [ -n "${OSM_FILE:-}" ] || [ "${SEED_OSM:-0}" = 1 ]; }
tiles_at () { $PSQL_Q -c "SELECT count(*) FROM tiles_for_geom(
    st_geomfromgeojson($(geo_region_literal)), $1, $1)"; }

# --------------------------------------------------------------- the region

if [ -n "${BBOX:-}" ]; then
    IFS=, read -r bw bs be bn extra <<< "$BBOX"
    for v in "${bw:-}" "${bs:-}" "${be:-}" "${bn:-}"; do
        [[ $v =~ ^-?[0-9]+(\.[0-9]+)?$ ]] || die "BBOX='$BBOX' is not west,south,east,north"
    done
    [ -z "${extra:-}" ] || die "BBOX='$BBOX' has more than four numbers"
    REGION_GEOJSON=$work/bbox.geojson
    printf '{"type": "Polygon", "coordinates": [[' > "$REGION_GEOJSON"
    printf '[%s, %s], [%s, %s], ' "$bw" "$bs" "$be" "$bs" >> "$REGION_GEOJSON"
    printf '[%s, %s], [%s, %s], ' "$be" "$bn" "$bw" "$bn" >> "$REGION_GEOJSON"
    printf '[%s, %s]]]}\n' "$bw" "$bs" >> "$REGION_GEOJSON"
fi
[ -s "$REGION_GEOJSON" ] || die "no region polygon at $REGION_GEOJSON"
case $GEO_ROOT_Z in 0 | 6 | 8 | 10 | 12) ;; *) die "GEO_ROOT_Z must be 0, 6, 8, 10 or 12";; esac

$PSQL_Q -c 'SELECT 1' > /dev/null 2>&1 || die "no database at\
 ${PGHOST:-localhost}:${PGPORT:-5432}/${PGDATABASE:-splatworld}; run: set -a; . ./.env; set +a"
read -r west south east north <<< "$(geo_bbox)"
[ -n "${north:-}" ] || die "$REGION_GEOJSON is not a polygon PostGIS can read"

# ----------------------------------------------------------------- preflight

# The 1-degree Copernicus cells the region's envelope touches.
cop_cells () {
    awk -v w="$west" -v s="$south" -v e="$east" -v n="$north" 'BEGIN {
        for (la = int(s); la <= int(n); la++)
            for (lo = int(w); lo <= int(e); lo++)
                printf "Copernicus_DSM_COG_10_N%02d_00_E%03d_00_DEM\n", la, lo;
    }'
}

check_dem () {
    [ -n "${DEM_SRC:-}${SWISSALTI_VRT:-}" ] && return 0
    local cell first want=0 have=0
    for cell in $(cop_cells); do
        want=$((want + 1))
        [ -s "$GEO_CACHE/$cell.tif" ] && have=$((have + 1))
    done
    [ "$have" = "$want" ] && return 0
    first=$(cop_cells | head -1)
    curl -sfI --max-time 30 -o /dev/null "$COP_BASE/$first/$first.tif" || die "$((want - have))\
 of $want Copernicus GLO-30 cells are missing and $COP_BASE is unreachable. Fetch\
 <cell>/<cell>.tif for each of $(cop_cells | tr '\n' ' ')into $GEO_CACHE/, or set DEM_SRC to a\
 GDAL dataset covering $west $south $east $north"
    say "dem: $((want - have)) of $want Copernicus cells still to download"
}

# The Sentinel-2 fallback is the least cloudy scene of one MGRS square, about
# 110 km across. Switzerland is 350 km and needs a mosaic; so does any region
# wider than a z8 tile, which is the closest thing this seed has to that size.
check_ortho () {
    [ -n "${ORTHO_SRC:-}" ] && return 0
    [ "$(tiles_at 8)" -le 1 ] || die "the region spans $(tiles_at 8) z8 tiles and the\
 Sentinel-2 fallback covers one MGRS square ($S2_SQUARE). Set ORTHO_SRC to a mosaic over\
 $west $south $east $north — a .vrt over swissimage, or over the scenes you want — or seed one\
 sub-region at a time with S2_SQUARE set for each"
    curl -sf --max-time 30 -o /dev/null "$S2_BASE/?list-type=2&max-keys=1" \
        || die "$S2_BASE is unreachable; set ORTHO_SRC to a local dataset"
}

check_osm () {
    command -v osm2pgsql > /dev/null || die "osm2pgsql is not installed (apt install osm2pgsql)"
    [ -n "${OSM_FILE:-}" ] || OSM_FILE=$GEO_CACHE/$(basename "$OSM_URL")
    [ -s "$OSM_FILE" ] && return 0
    curl -sfI --max-time 30 -o /dev/null "$OSM_URL" || die "no OSM extract at $OSM_FILE and\
 $OSM_URL is unreachable. Download it on a networked box, put it there, and run this again"
    say "osm: $OSM_FILE will be downloaded from $OSM_URL first"
}

if [ "${SEED_GEO:-0}" = 1 ]; then
    for c in gdalwarp gdal_translate gdalbuildvrt; do
        command -v "$c" > /dev/null || die "$c is not installed (apt install gdal-bin)"
    done
    check_dem
    check_ortho
fi
want_osm && check_osm

# ---------------------------------------------------------------------- plan

say "$REGION_GEOJSON, $west $south $east $north, z$REGION_MIN_Z..z$REGION_MAX_Z"
TILES=0
for z in $(seq "$REGION_MIN_Z" 2 "$REGION_MAX_Z"); do
    n=$(tiles_at "$z")
    TILES=$((TILES + n))
    say "  z$z: $n tiles"
done
say "  $TILES tiles a kind: $((TILES * 131072 / 1048576)) MiB of dem,\
 about $((TILES * 25000 / 1048576)) MiB of ortho"
[ "${DRY_RUN:-0}" = 1 ] && { say "dry run, nothing written"; exit 0; }

# ------------------------------------------------------------ the world rows

geo_seed_areas "$SEED_NAME"
geo_mark_dirty "$REGION_MIN_Z" "$REGION_MAX_Z"

# ---------------------------------------------------------------- the inputs

# The region clipped to one root tile. Both raster seeds read geo_tiles(), so
# handing them a piece of the region at a time is all it takes to make a country
# report progress as it goes and register its artifacts in batches, rather than
# print one line after four hours and write 30 000 rows in one transaction.
root_region () {
    $PSQL_Q -c "SELECT st_asgeojson(st_collectionextract(st_intersection(
        st_geomfromgeojson($(geo_region_literal)), tile_bbox($1, $2, $3)), 3))" \
        > "$work/root.geojson"
}

run_raster () { # label script
    local label=$1 script=$2 i=0 total x y t0 out coarse root_min start=$SECONDS
    root_min=$GEO_ROOT_Z
    [ "$root_min" -lt "$REGION_MIN_Z" ] && root_min=$REGION_MIN_Z
    if [ "$REGION_MIN_Z" -lt "$GEO_ROOT_Z" ]; then
        coarse=$((GEO_ROOT_Z - 2))
        [ "$coarse" -gt "$REGION_MAX_Z" ] && coarse=$REGION_MAX_Z
        out=$(env REGION_MAX_Z="$coarse" bash "$script" 2>&1) \
            || { echo "$out" >&2; die "$label z$REGION_MIN_Z..z$coarse failed"; }
        say "$label z$REGION_MIN_Z..z$coarse $(sed -n 's/^# seed-[a-z]*: //p' <<< "$out")"
    fi
    [ "$REGION_MAX_Z" -ge "$root_min" ] || return 0
    $PSQL_Q -c "SELECT t.x || ' ' || t.y FROM tiles_for_geom(
        st_geomfromgeojson($(geo_region_literal)), $GEO_ROOT_Z, $GEO_ROOT_Z) AS t
        ORDER BY t.x, t.y" > "$work/roots"
    total=$(wc -l < "$work/roots")
    while read -r x y; do
        i=$((i + 1)); t0=$SECONDS
        root_region "$GEO_ROOT_Z" "$x" "$y"
        out=$(env REGION_GEOJSON="$work/root.geojson" REGION_MIN_Z="$root_min" \
            bash "$script" 2>&1) || { echo "$out" >&2
            die "$label root $GEO_ROOT_Z/$x/$y failed; fix it and run the same command again"; }
        say "$label $i/$total $GEO_ROOT_Z/$x/$y $(hms $((SECONDS - t0)))\
 $(sed -n 's/^# seed-[a-z]*: //p' <<< "$out")"
        [ $((i % 10)) = 0 ] && say "$label elapsed $(hms $((SECONDS - start))),\
 eta $(hms $(((SECONDS - start) * (total - i) / i)))"
    done < "$work/roots"
    say "$label done in $(hms $((SECONDS - start)))"
}

if [ "${SEED_GEO:-0}" = 1 ]; then
    run_raster dem tools/seed-dem.sh
    run_raster ortho tools/seed-ortho.sh
fi

# ------------------------------------------------------------------- the OSM

# Which extract an area was seeded from, so an interrupted run knows what is
# left and a newer extract is picked up. The mark is written only after
# seed-osm.sh has committed: its feature insert is one transaction, so a run
# that dies partway leaves neither features nor a mark behind.
osm_sig () { printf '%s-%s' "$(basename "$OSM_FILE" | tr -cd 'A-Za-z0-9._-')" \
    "$(stat -c%s "$OSM_FILE")"; }
SIG=$([ -s "${OSM_FILE:-}" ] && osm_sig || echo none)

osm_areas () { # sql-predicate
    $PSQL_Q -c "SELECT count(*) FROM area a
        JOIN tiles_for_geom(st_geomfromgeojson($(geo_region_literal)), 12, 12) AS t
            ON a.rules ->> 'z12' = t.x || '/' || t.y
        WHERE a.owner_id = (SELECT id FROM auth.user WHERE email = '$SEED_EMAIL') AND $1"
}

if want_osm; then
    STALE="a.rules ->> 'osm_extract' IS DISTINCT FROM '$SIG'"
    if [ "${FORCE:-0}" != 1 ] && [ "$(osm_areas "$STALE")" = 0 ]; then
        say "osm: every area of the region is already seeded from $SIG"
    else
        t0=$SECONDS
        OSM_FILE=$OSM_FILE SEED_NAME=$SEED_NAME bash tools/seed-osm.sh
        SIG=$(osm_sig)
        $PSQL_Q -c "UPDATE area a
            SET rules = a.rules || jsonb_build_object('osm_extract', '$SIG')
            WHERE a.owner_id = (SELECT id FROM auth.user WHERE email = '$SEED_EMAIL')
              AND EXISTS (SELECT 1 FROM tiles_for_geom(
                  st_geomfromgeojson($(geo_region_literal)), 12, 12) AS t
                  WHERE a.rules ->> 'z12' = t.x || '/' || t.y)" > /dev/null
        say "osm done in $(hms $((SECONDS - t0))), areas marked $SIG"
    fi
fi

# ----------------------------------------------------------------- the count

$PSQL_Q -c "SELECT '# seed-ch: z' || t.z || ': ' || count(*) || ' tile rows, '
        || count(*) FILTER (WHERE t.dirty) || ' dirty'
    FROM tile t
    JOIN tiles_for_geom(st_geomfromgeojson($(geo_region_literal)),
        $REGION_MIN_Z, $REGION_MAX_Z) AS r ON r.z = t.z AND r.x = t.x AND r.y = t.y
    GROUP BY t.z ORDER BY t.z"
say "$(osm_areas true) system areas over the region,\
 $(osm_areas "a.rules ? 'osm_extract'") of them seeded from an OSM extract"
$PSQL_Q -c "SELECT '# seed-ch: ' ||
    (SELECT count(*) FROM area WHERE rules ->> 'seed' = '$SEED_NAME') || ' areas named ' ||
    '$SEED_NAME, ' || (SELECT count(*) FROM tile WHERE z = 14 AND dirty) ||
    ' dirty z14 tiles in the world, ' || (SELECT count(*) FROM tile) || ' tile rows'"
