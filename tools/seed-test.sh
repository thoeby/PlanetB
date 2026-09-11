#!/usr/bin/env bash
# WP2.1 — the seeding gate. Runs tools/seed-osm.sh over the committed fixture
# and asserts the world it produces, then cuts one z14 DEM and ortho tile
# straight off AWS open data and asserts they are registered and served
# immutable. The geo half skips, rather than fails, where the sources cannot be
# reached — same rule the browser tests follow for the CDN.
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=tools/geo-common.sh
. tools/geo-common.sh

FILES_URL=${FILES_URL:-http://localhost:8080}
API_URL=${API_URL:-http://localhost:3000}
FIXTURE=infra/seed/pilot-fixture.osm
PASS=0
FAIL=0
ok () { echo "ok - $1"; PASS=$((PASS + 1)); }
no () { echo "not ok - $1"; FAIL=$((FAIL + 1)); }
is () { [ "$2" = "$3" ] && ok "$1" || no "$1 (expected $2, got $3)"; }
q () { $PSQL_Q -c "$1"; }

# ------------------------------------------------------------------ services

cleanup () { [ -n "${NGINX_CONF:-}" ] && nginx -c "$NGINX_CONF" -s quit 2>/dev/null || true
             [ -n "${PGRST_PID:-}" ] && kill "$PGRST_PID" 2>/dev/null || true; }
trap cleanup EXIT

if ! curl -sf -o /dev/null "$API_URL/"; then
    command -v postgrest > /dev/null || { echo "not ok - no API and no postgrest binary"; exit 1; }
    conf=$(mktemp)
    cat > "$conf" <<CONF
# Keyword form, not a URL: a URL has nowhere to put a Unix socket
# directory, and PGHOST=/var/run/postgresql is what a Debian or Ubuntu
# install leaves behind. PostgREST then answers 503 to everything.
db-uri = "host='${PGHOST:-localhost}' port='${PGPORT:-5432}' user=authenticator password='${AUTHENTICATOR_PASSWORD:-authenticator}' dbname='${PGDATABASE:-splatworld}'"
db-schemas = "api"
db-anon-role = "anon"
jwt-secret = "${JWT_SECRET:?JWT_SECRET must be set}"
server-port = ${API_URL##*:}
CONF
    env -u PGRST_DB_URI -u PGRST_DB_SCHEMAS -u PGRST_DB_ANON_ROLE \
        -u PGRST_JWT_SECRET -u PGRST_SERVER_PORT postgrest "$conf" > /tmp/postgrest.log 2>&1 &
    PGRST_PID=$!
    for _ in $(seq 1 40); do curl -sf -o /dev/null "$API_URL/" && break; sleep 0.25; done
fi

if ! curl -sf -o /dev/null "$FILES_URL/healthz"; then
    command -v nginx > /dev/null || { echo "not ok - no file store and no nginx binary"; exit 1; }
    mkdir -p "$FILES_ROOT"; chmod 1777 "$FILES_ROOT"; ROOT=$(cd "$FILES_ROOT" && pwd)
    NGINX_CONF=$(mktemp --suffix=.conf)
    sed -e "s|server postgrest:3000;|server 127.0.0.1:${API_URL##*:};|" \
        -e "s|listen 80;|listen ${FILES_URL##*:};|" \
        -e "s|root /srv/files;|root $ROOT;|" \
        -e "1i pid /tmp/splatworld-nginx.pid;\nerror_log /tmp/splatworld-nginx-error.log;" \
        infra/nginx.conf > "$NGINX_CONF"
    sed -i "s|^http {|http {\n    access_log /tmp/splatworld-nginx-access.log;\n    client_body_temp_path /tmp/splatworld-nginx-body;\n    proxy_temp_path /tmp/splatworld-nginx-proxy;\n    fastcgi_temp_path /tmp/splatworld-nginx-fcgi;\n    uwsgi_temp_path /tmp/splatworld-nginx-uwsgi;\n    scgi_temp_path /tmp/splatworld-nginx-scgi;|" "$NGINX_CONF"
    nginx -c "$NGINX_CONF"
    for _ in $(seq 1 20); do curl -sf -o /dev/null "$FILES_URL/healthz" && break; sleep 0.25; done
    echo "# started a local nginx on $FILES_URL rooted at $ROOT"
fi

# ----------------------------------------------------------------------- osm

OSM_FILE=$FIXTURE bash tools/seed-osm.sh > /dev/null
is "the fixture's features are all in the world" 7 \
    "$(q "SELECT count(*) FROM feature WHERE props ? 'osm'")"
is "a tagged height and level count survive" "18|5" \
    "$(q "SELECT (props ->> 'height') || '|' || (props ->> 'levels')
          FROM feature WHERE props ->> 'osm' = 'W100'")"
is "a multipolygon relation becomes one forest" "forest|1" \
    "$(q "SELECT kind || '|' || st_numinteriorrings(st_geometryn(geom, 1))
          FROM feature WHERE props ->> 'osm' = 'R200'")"
is "a road with no width tag gets its class profile" "residential|5" \
    "$(q "SELECT (props ->> 'class') || '|' || (props ->> 'width')
          FROM feature WHERE props ->> 'osm' = 'W103'")"
is "one system area per z12 child of the pilot, detail 14" 16 \
    "$(q "SELECT count(*) FROM area WHERE rules ? 'z12' AND detail = 14")"
is "the fixture dirtied a tile at every zoom from 6 to 14" "6,8,10,12,14" \
    "$(q "SELECT string_agg(z::text, ',' ORDER BY z) FROM (
            SELECT DISTINCT t.z FROM tile t
            JOIN feature f ON st_intersects(tile_bbox(t.z, t.x, t.y), f.geom)
            WHERE f.props ->> 'osm' = 'W100' AND t.dirty) AS zs")"

# Re-running must not double the world: every insert is keyed by its OSM id.
OSM_FILE=$FIXTURE bash tools/seed-osm.sh > /dev/null
is "seeding twice leaves the same 7 features" 7 \
    "$(q "SELECT count(*) FROM feature WHERE props ? 'osm'")"

# ------------------------------------------------------------------ dem/ortho

# One z14 tile of the pilot, cut straight off the remote sources.
Z=14; X=$((PILOT_X * 16 + 8)); Y=$((PILOT_Y * 16 + 8))
seed_one () { # script kind ext extra-env...
    local script=$1 kind=$2 ext=$3; shift 3
    env FORCE=1 PILOT_Z=$Z PILOT_X=$X PILOT_Y=$Y PILOT_MAX_Z=$Z DETAIL_MAX_Z=0 "$@" \
        bash "$script" > /dev/null 2>&1
}

if seed_one tools/seed-dem.sh dem r16 DEM_STREAM=1; then
    dem=$(geo_store_path dem "$Z" "$X" "$Y" r16)
    is "a z14 dem tile is 256x256 uint16" 131072 "$(stat -c%s "$dem")"
    is "it is registered as a dem artifact" "dem|dem-v1" \
        "$(q "SELECT kind || '|' || algo_version FROM artifact
              WHERE sha256 = '$(sha256sum "$dem" | cut -d' ' -f1)'")"
    hdrs=$(curl -s -D - -o /dev/null "$FILES_URL/geo/dem/$Z/$X/$Y.r16")
    grep -q '200 OK' <<< "$hdrs" && ok "GET /geo/dem/$Z/$X/$Y.r16 is served" \
        || no "GET /geo/dem/$Z/$X/$Y.r16 is served"
    grep -qi 'cache-control: public, max-age=31536000, immutable' <<< "$hdrs" \
        && ok "a dem tile is immutable and cacheable for a year" \
        || no "a dem tile is immutable and cacheable for a year"
    # dem-v1: elevation_m = value * 0.2 - 500. The pilot is the Swiss plateau.
    node -e '
        const fs = require("node:fs");
        const b = fs.readFileSync(process.argv[1]);
        const a = new Uint16Array(b.buffer, b.byteOffset, b.length / 2);
        let lo = Infinity, hi = -Infinity;
        for (const v of a) { const e = v * 0.2 - 500; lo = Math.min(lo, e); hi = Math.max(hi, e); }
        process.exit(lo > 200 && hi < 2000 && hi - lo > 5 ? 0 : 1);' "$dem" \
        && ok "its elevations are the pilot's, 200-2000 m with relief" \
        || no "its elevations are the pilot's, 200-2000 m with relief"
else
    echo "# seed-test: the DEM source is unreachable, dem assertions skipped"
fi

if seed_one tools/seed-ortho.sh ortho webp ORTHO_STREAM=1; then
    ortho=$(geo_store_path ortho "$Z" "$X" "$Y" webp)
    is "a z14 ortho tile is a 512x512 webp" "WEBP 512, 512" \
        "$(gdalinfo "$ortho" | sed -n 's/^Driver: \(WEBP\).*/\1/p; s/^Size is \(.*\)/\1/p' | paste -sd' ')"
    is "it is registered as an ortho artifact" "ortho|ortho-v1" \
        "$(q "SELECT kind || '|' || algo_version FROM artifact
              WHERE sha256 = '$(sha256sum "$ortho" | cut -d' ' -f1)'")"
    hdrs=$(curl -s -D - -o /dev/null "$FILES_URL/geo/ortho/$Z/$X/$Y.webp")
    grep -qi 'cache-control: public, max-age=31536000, immutable' <<< "$hdrs" \
        && ok "an ortho tile is immutable and cacheable for a year" \
        || no "an ortho tile is immutable and cacheable for a year"
else
    echo "# seed-test: the ortho source is unreachable, ortho assertions skipped"
fi

echo "# $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
