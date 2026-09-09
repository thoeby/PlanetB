#!/usr/bin/env bash
# WP2.1 — turns OSM into the world: one system `area` per z12 tile of the pilot
# (detail 14) and a `feature` row per road, forest, water body and building
# footprint inside it.
#
#     set -a; . ./.env; set +a; OSM_FILE=switzerland.osm.pbf bash tools/seed-osm.sh
#
# Input, in order of preference:
#   OSM_FILE   a .osm.pbf or .osm on disk
#   OSM_URL    fetched into $GEO_CACHE (default: the Geofabrik Switzerland extract)
#
# osm2pgsql writes into schema `seed`; the mapping onto `feature` is one SQL
# statement per kind, so re-running only adds what is new. Inserting a feature
# fires the dirty trigger, which is what puts z6..z14 tile rows in the world.
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=tools/geo-common.sh
. tools/geo-common.sh

OSM_URL=${OSM_URL:-https://download.geofabrik.de/europe/switzerland-latest.osm.pbf}
KEEP_STAGING=${KEEP_STAGING:-0}
export CURL_CA_BUNDLE=${CURL_CA_BUNDLE:-/etc/ssl/certs/ca-certificates.crt}

read -r west south east north <<< "$(geo_bbox)"

if [ -z "${OSM_FILE:-}" ]; then
    mkdir -p "$GEO_CACHE"
    OSM_FILE="$GEO_CACHE/$(basename "$OSM_URL")"
    if [ ! -s "$OSM_FILE" ]; then
        echo "# fetching $OSM_URL" >&2
        curl -sSf -o "$OSM_FILE.part" "$OSM_URL" \
            || { rm -f "$OSM_FILE.part"; echo "not ok - $OSM_URL unreachable"; exit 1; }
        mv "$OSM_FILE.part" "$OSM_FILE"
    fi
fi
[ -s "$OSM_FILE" ] || { echo "not ok - no OSM extract at $OSM_FILE"; exit 1; }

# ------------------------------------------------------------------ staging

$PSQL_Q -c "SET client_min_messages = warning;
    CREATE SCHEMA IF NOT EXISTS seed; DROP TABLE IF EXISTS seed.osm_seed" > /dev/null
osm2pgsql --log-level=warn --log-progress=false --output=flex --style=tools/osm-flex.lua \
    --bbox="$west,$south,$east,$north" \
    --database="${PGDATABASE:-splatworld}" --host="${PGHOST:-localhost}" \
    --port="${PGPORT:-5432}" --user="${PGUSER:-postgres}" \
    "$OSM_FILE"

# ------------------------------------------------------- areas and features

# One area per z12 tile of the seed, detail 14: the baseline the whole of WP2
# compiles. Owned by the seed user, which is also who `created_by` names on the
# geo artifacts.
geo_seed_areas "${SEED_NAME:-pilot}"

sql=$(mktemp); trap 'rm -f "$sql"' EXIT
cat > "$sql" <<SQL
SET client_min_messages = warning;
DO \$seed\$
DECLARE
    uid uuid;
    n   int;
BEGIN
    SELECT id INTO uid FROM auth.user WHERE email = '$SEED_EMAIL';
    IF uid IS NULL THEN uid := register('$SEED_EMAIL', 'seed-pw-not-a-login'); END IF;
    UPDATE auth.user SET role = 'admin' WHERE id = uid;

    -- Assigned by a point that is certainly on the geometry, so the feature is
    -- inside the area it names and bump_rev() accepts it. Z comes from the DEM
    -- at assemble time; the world stores plan geometry at Z = 0.
    INSERT INTO feature (area_id, kind, geom, props)
    SELECT a.id, s.kind, st_force3d(st_makevalid(s.geom)),
           jsonb_strip_nulls(coalesce(s.props, '{}'::jsonb))
               || jsonb_build_object('osm', s.osm_type || s.osm_id)
    FROM seed.osm_seed s
    JOIN area a ON a.owner_id = uid AND st_intersects(a.geom, st_pointonsurface(s.geom))
    WHERE st_isvalid(st_makevalid(s.geom))
      AND NOT EXISTS (SELECT 1 FROM feature f
                      WHERE f.props ->> 'osm' = s.osm_type || s.osm_id);
    GET DIAGNOSTICS n = ROW_COUNT;
    RAISE NOTICE 'seed-osm: % features inserted', n;
END
\$seed\$;
SQL
psql -v ON_ERROR_STOP=1 --no-psqlrc -q -f "$sql"

[ "$KEEP_STAGING" = 1 ] || $PSQL_Q -c "SET client_min_messages = warning;
    DROP TABLE IF EXISTS seed.osm_seed" > /dev/null

$PSQL_Q -c "SELECT '# seed-osm: ' || string_agg(k.kind || ' ' || k.n, ', ' ORDER BY k.kind)
    FROM (SELECT kind, count(*) AS n FROM feature
          WHERE props ? 'osm' GROUP BY kind) AS k"
$PSQL_Q -c "SELECT '# seed-osm: ' ||
    (SELECT count(*) FROM area WHERE rules ? 'z12') || ' areas, ' ||
    (SELECT count(*) FROM tile) || ' tile rows, ' ||
    (SELECT count(*) FROM tile WHERE dirty) || ' dirty'"
