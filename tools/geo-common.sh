#!/usr/bin/env bash
# Shared by tools/seed-dem.sh and tools/seed-ortho.sh: what the pilot region is,
# how a tile maps to Web-Mercator metres, where cut tiles land, and how they are
# registered as artifacts. Sourced, never run.
#
# Dev-box tooling. The server executes no compute (Invariant 9) — these scripts
# only pre-cut inputs into the immutable file store and record them in the
# database, exactly as a human with GDAL and psql would.

MERC_R=20037508.342789244

# The pilot: one z10 tile over Aarau, Switzerland (7.734-8.086 E, 47.279-47.517 N),
# cut at z10, z12 and z14. One z16 child of it — the tile at the pilot's centre —
# is cut deeper, so WP3 has a z16/z18 pocket without seeding 4096 tiles for it.
PILOT_Z=${PILOT_Z:-10}
PILOT_X=${PILOT_X:-534}
PILOT_Y=${PILOT_Y:-358}
PILOT_MAX_Z=${PILOT_MAX_Z:-14}
DETAIL_Z=${DETAIL_Z:-16}
DETAIL_X=${DETAIL_X:-$((PILOT_X * (1 << (DETAIL_Z - PILOT_Z)) + (1 << (DETAIL_Z - PILOT_Z - 1))))}
DETAIL_Y=${DETAIL_Y:-$((PILOT_Y * (1 << (DETAIL_Z - PILOT_Z)) + (1 << (DETAIL_Z - PILOT_Z - 1))))}
DETAIL_MAX_Z=${DETAIL_MAX_Z:-18}

# A region is a polygon on disk instead of a single root tile: REGION_GEOJSON
# names a GeoJSON geometry in EPSG:4326 and REGION_MAX_Z says how deep to cut
# it. Every tool that seeds by tile reads geo_tiles(), so naming a region is all
# it takes to seed a country instead of the pilot (WP5.1).
REGION_GEOJSON=${REGION_GEOJSON:-}
REGION_MIN_Z=${REGION_MIN_Z:-6}
REGION_MAX_Z=${REGION_MAX_Z:-14}

FILES_ROOT=${FILES_ROOT:-./infra/files}
GEO_CACHE=${GEO_CACHE:-./infra/seed/cache}
SEED_EMAIL=${SEED_EMAIL:-seed@splatworld.local}

PSQL_Q="psql -v ON_ERROR_STOP=1 --no-psqlrc -q -t -A"

# Every tile this seed covers, coarse to fine, as "z x y".
geo_tiles () {
    if [ -n "$REGION_GEOJSON" ]; then
        geo_region_tiles "$REGION_MIN_Z" "$REGION_MAX_Z"
        return
    fi
    geo_subtree "$PILOT_Z" "$PILOT_X" "$PILOT_Y" "$PILOT_MAX_Z"
    geo_subtree "$DETAIL_Z" "$DETAIL_X" "$DETAIL_Y" "$DETAIL_MAX_Z"
}

# The region polygon as a dollar-quoted SQL literal.
geo_region_literal () { printf '$g$%s$g$' "$(cat "$REGION_GEOJSON")"; }

# The region's tiles, from the world's own tile maths rather than a second copy
# of it in awk: tiles_for_geom (db/0004_tiles.sql) is what the dirty trigger
# uses, so a seeded tile and a dirtied one are the same tile.
geo_region_tiles () {
    $PSQL_Q -c "SELECT t.z || ' ' || t.x || ' ' || t.y
                FROM tiles_for_geom(st_geomfromgeojson($(geo_region_literal)),
                    $1, $2) AS t ORDER BY t.z, t.x, t.y"
}

# The region's lon/lat envelope, as "west south east north" — what a source
# mosaic has to cover.
geo_region_bbox () {
    $PSQL_Q -c "SELECT round(st_xmin(g)::numeric, 6) || ' ' || round(st_ymin(g)::numeric, 6)
                    || ' ' || round(st_xmax(g)::numeric, 6) || ' '
                    || round(st_ymax(g)::numeric, 6)
                FROM (SELECT st_envelope(st_geomfromgeojson(
                    $(geo_region_literal))) AS g) e"
}

# What the seed covers in lon/lat, region or pilot, as "west south east north".
geo_bbox () {
    if [ -n "$REGION_GEOJSON" ]; then geo_region_bbox
    else geo_lonlat_bounds "$PILOT_Z" "$PILOT_X" "$PILOT_Y"; fi
}

# Every even zoom from (z x y) down to max_z, as "z x y".
geo_subtree () {
    local rz=$1 rx=$2 ry=$3 max=$4 z f x y
    for z in $(seq "$rz" 2 "$max"); do
        f=$((1 << (z - rz)))
        for ((x = rx * f; x < (rx + 1) * f; x++)); do
            for ((y = ry * f; y < (ry + 1) * f; y++)); do echo "$z $x $y"; done
        done
    done
}

# EPSG:3857 bounds of a tile, as "xmin ymin xmax ymax" — what gdalwarp -te wants.
geo_bounds () {
    awk -v r="$MERC_R" -v z="$1" -v x="$2" -v y="$3" 'BEGIN {
        s = 2 * r / 2 ^ z;
        printf "%.6f %.6f %.6f %.6f\n", -r + x * s, r - (y + 1) * s, -r + (x + 1) * s, r - y * s;
    }'
}

# Lon/lat bounds of a tile, as "west south east north" — what osm2pgsql --bbox
# and PostGIS want. Mirrors tile_bbox() in db/0004_tiles.sql.
geo_lonlat_bounds () {
    awk -v z="$1" -v x="$2" -v y="$3" 'BEGIN {
        n = 2 ^ z; pi = 3.14159265358979;
        for (i = 0; i < 2; i++) {
            t = pi * (1 - 2 * (y + i) / n);
            lat[i] = atan2((exp(t) - exp(-t)) / 2, 1) * 180 / pi;
        }
        printf "%.9f %.9f %.9f %.9f\n", x / n * 360 - 180, lat[1], (x + 1) / n * 360 - 180, lat[0];
    }'
}

# The tile rows a region's baseline promises, dirty and at version 1 so
# ensure_job() will open a job for them. A trigger marks tiles dirty when
# somebody edits the world (ARCHITECTURE, "Triggers"); ground nobody has edited
# has no edit to fire one, so the seed writes the rows the same way the trigger
# would, from the same tiles_for_geom. A tile the world already knows is left
# exactly as it is: re-seeding is not an edit either.
geo_mark_dirty () {
    $PSQL_Q -c "INSERT INTO tile (z, x, y, dirty, expected_version)
                SELECT t.z, t.x, t.y, true, 1
                FROM tiles_for_geom(st_geomfromgeojson($(geo_region_literal)),
                    $1, $2) AS t
                ON CONFLICT (z, x, y) DO NOTHING"
}

# One system `area` per z12 tile of the seed, detail 14: the baseline the world
# compiles, and the promise that this ground is drawn at all. Idempotent — an
# area names its z12 tile in `rules`, and a second run adds only what is new.
# What the areas promise to draw is geo_mark_dirty()'s business, above.
geo_seed_areas () {
    local name=$1 src sql
    if [ -n "$REGION_GEOJSON" ]; then
        src="SELECT t.x, t.y FROM tiles_for_geom(
                 st_geomfromgeojson($(geo_region_literal)), 12, 12) AS t"
    else
        src="SELECT gx.x, gy.y
             FROM generate_series($((PILOT_X * 4)), $((PILOT_X * 4 + 3))) AS gx (x),
                 generate_series($((PILOT_Y * 4)), $((PILOT_Y * 4 + 3))) AS gy (y)"
    fi
    sql=$(mktemp); trap 'rm -f "$sql"' RETURN
    cat > "$sql" <<SQL
-- notice, not warning: the RAISE below is the one number an operator resuming
-- an interrupted country run wants, and warning would swallow it.
SET client_min_messages = notice;
DO \$seed\$ DECLARE uid uuid; n int; BEGIN
    SELECT id INTO uid FROM auth.user WHERE email = '$SEED_EMAIL';
    IF uid IS NULL THEN uid := register('$SEED_EMAIL', 'seed-pw-not-a-login'); END IF;
    UPDATE auth.user SET role = 'admin' WHERE id = uid;
    INSERT INTO area (geom, owner_id, detail, rules)
    SELECT tile_bbox(12, t.x, t.y), uid, 14,
        jsonb_build_object('seed', '$name', 'z12', t.x || '/' || t.y)
    FROM ($src) AS t (x, y)
    WHERE NOT EXISTS (
        SELECT 1 FROM area a
        WHERE a.owner_id = uid AND a.rules ->> 'z12' = t.x || '/' || t.y);
    GET DIAGNOSTICS n = ROW_COUNT;
    RAISE NOTICE 'seed-areas: % system areas added', n;
END \$seed\$;
SQL
    psql -v ON_ERROR_STOP=1 --no-psqlrc -q -f "$sql"
}

geo_store_path () { echo "$FILES_ROOT/geo/$1/$2/$3/$4.$5"; }

# Registers what a seed wrote. Lines on stdin are "sha256 bytes"; one
# register_artifact call each, under the seed user's identity, so created_by is
# a real user and the RPC is the same one a worker calls.
geo_register () {
    local kind=$1 algo=$2 sql
    sql=$(mktemp); trap 'rm -f "$sql"' RETURN
    {
        echo "SET client_min_messages = warning;"
        echo "DO \$seed\$ DECLARE uid uuid; BEGIN"
        echo "  SELECT id INTO uid FROM auth.user WHERE email = '$SEED_EMAIL';"
        echo "  IF uid IS NULL THEN uid := register('$SEED_EMAIL', 'seed-pw-not-a-login'); END IF;"
        echo "  UPDATE auth.user SET role = 'admin' WHERE id = uid;"
        echo "  PERFORM set_config('request.jwt.claims',"
        echo "      json_build_object('sub', uid, 'role', 'admin')::text, true);"
        while read -r sha bytes; do
            echo "  PERFORM register_artifact('$sha', '$kind', $bytes, '$algo');"
        done
        echo "END \$seed\$;"
    } > "$sql"
    $PSQL_Q -f "$sql" > /dev/null
}

# The store is served by nginx, whose workers run as www-data; the seeds write
# into it directly because /geo is not a client upload path (ARCHITECTURE §7).
geo_mkstore () { mkdir -p "$FILES_ROOT/geo"; chmod 1777 "$FILES_ROOT" 2>/dev/null || true; }
