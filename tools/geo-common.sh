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

FILES_ROOT=${FILES_ROOT:-./infra/files}
GEO_CACHE=${GEO_CACHE:-./infra/seed/cache}
SEED_EMAIL=${SEED_EMAIL:-seed@splatworld.local}

PSQL_Q="psql -v ON_ERROR_STOP=1 --no-psqlrc -q -t -A"

# Every tile this seed covers, coarse to fine, as "z x y".
geo_tiles () {
    geo_subtree "$PILOT_Z" "$PILOT_X" "$PILOT_Y" "$PILOT_MAX_Z"
    geo_subtree "$DETAIL_Z" "$DETAIL_X" "$DETAIL_Y" "$DETAIL_MAX_Z"
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
