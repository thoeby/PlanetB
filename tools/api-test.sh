#!/usr/bin/env bash
# WP0.9 — PostgREST smoke test: register, login, anon reads, RLS on writes,
# ensure_job, claim_atom. Runs against $API_URL (the compose stack by default);
# if nothing is listening and a postgrest binary is available, it starts one.
set -euo pipefail

API_URL=${API_URL:-http://localhost:3000}
PSQL="psql -v ON_ERROR_STOP=1 --no-psqlrc -q -t -A"
PASS=0
FAIL=0

ok () { echo "ok - $1"; PASS=$((PASS + 1)); }
no () { echo "not ok - $1"; FAIL=$((FAIL + 1)); }
is () { [ "$2" = "$3" ] && ok "$1" || no "$1 (expected $2, got $3)"; }

body=$(mktemp)
code () { # method path [json] [token]
    local m=$1 p=$2 d=${3:-} t=${4:-}
    local args=(-s -o "$body" -w '%{http_code}' -X "$m" "$API_URL$p"
                -H 'Content-Type: application/json')
    [ -n "$t" ] && args+=(-H "Authorization: Bearer $t")
    [ -n "$d" ] && args+=(-d "$d")
    curl "${args[@]}"
}

# ------------------------------------------------------------------- server
started=""
if ! curl -sf -o /dev/null "$API_URL/"; then
    PGRST=$(command -v postgrest || true)
    [ -x "${PGRST:-}" ] || { echo "not ok - nothing serving $API_URL and no postgrest binary"; exit 1; }
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
    # PGRST_* env vars override the config file; .env points them at the
    # compose stack, so clear them for a local run.
    env -u PGRST_DB_URI -u PGRST_DB_SCHEMAS -u PGRST_DB_ANON_ROLE \
        -u PGRST_JWT_SECRET -u PGRST_SERVER_PORT \
        "$PGRST" "$conf" > "${PGRST_LOG:-/tmp/postgrest.log}" 2>&1 &
    started=$!
    trap 'kill $started 2>/dev/null || true' EXIT
    for _ in $(seq 1 40); do curl -sf -o /dev/null "$API_URL/" && break; sleep 0.25; done
    curl -sf -o /dev/null "$API_URL/" || { echo "not ok - postgrest did not start"; tail -5 "${PGRST_LOG:-/tmp/postgrest.log}"; exit 1; }
    echo "# started a local postgrest on $API_URL"
fi

# ------------------------------------------------------------------ fixtures
STAMP=$(date +%s%N)
OWNER="owner$STAMP@example.com"
OTHER="other$STAMP@example.com"

# ------------------------------------------------------------------ register
is "register returns 200" 200 "$(code POST /rpc/register "{\"email\":\"$OWNER\",\"pw\":\"password12\"}")"
OWNER_ID=$(tr -d '"' < "$body")
code POST /rpc/register "{\"email\":\"$OTHER\",\"pw\":\"password12\"}" > /dev/null
OTHER_ID=$(tr -d '"' < "$body")

is "login with a bad password fails" 403 "$(code POST /rpc/login "{\"email\":\"$OWNER\",\"pw\":\"nope\"}")"
is "login returns 200" 200 "$(code POST /rpc/login "{\"email\":\"$OWNER\",\"pw\":\"password12\"}")"
OWNER_JWT=$(tr -d '"' < "$body")
code POST /rpc/login "{\"email\":\"$OTHER\",\"pw\":\"password12\"}" > /dev/null
OTHER_JWT=$(tr -d '"' < "$body")
[ -n "$OWNER_JWT" ] && ok "the token is non-empty" || no "the token is non-empty"

# Areas are seeded by an admin, never by the API (no write grant on area).
# A per-run offset keeps repeated runs off each other's tiles.
OFF=$(( (STAMP / 1000000) % 200 ))
LON=$(awk "BEGIN{printf \"%.4f\", 9.0 + $OFF * 0.015}")
LAT=$(awk "BEGIN{printf \"%.4f\", 46.0 + $OFF * 0.004}")
# Nothing may be drawn outside the world's ground (db/0062_insideground.sql),
# so this world reaches where this run works.
$PSQL -c "INSERT INTO ground (only_one, geoserver_url, coverage, extent)
    VALUES (true, 'http://test.invalid/geoserver', 'test:ground',
            st_makeenvelope($LON - 1, $LAT - 1, $LON + 1, $LAT + 1, world_srid()))
    ON CONFLICT (only_one) DO UPDATE
    SET extent = st_envelope(st_collect(ground.extent, excluded.extent))" > /dev/null
AREA=$($PSQL -c "INSERT INTO area (geom, owner_id, detail) VALUES (
    st_makeenvelope($LON - 0.02, $LAT - 0.02, $LON + 0.02, $LAT + 0.02, world_srid()),
    '$OWNER_ID', 14) RETURNING id")

# ------------------------------------------------------------------- reads
is "anon can read tiles" 200 "$(code GET /tile)"
is "anon can read the catalog" 200 "$(code GET /asset)"
is "anon can read areas" 200 "$(code GET /area)"

# ------------------------------------------------------------------- writes
GEOM=$($PSQL -c "SELECT encode(st_asewkb(st_force3d(st_buffer(
    st_setsrid(st_makepoint($LON, $LAT), world_srid()), 0.004))), 'hex')")
FEATURE="{\"area_id\":\"$AREA\",\"kind\":\"forest\",\"geom\":\"$GEOM\"}"
is "anon cannot write a feature" 401 "$(code POST /feature "$FEATURE")"
is "a stranger cannot write in my area" 403 "$(code POST /feature "$FEATURE" "$OTHER_JWT")"
is "the owner can write in their area" 201 "$(code POST /feature "$FEATURE" "$OWNER_JWT")"

# --------------------------------------------------------------------- jobs
Z=14
X=$($PSQL -c "SELECT tile_x($LON, 14)")
Y=$($PSQL -c "SELECT tile_y($LAT, 14)")

is "a stranger cannot open a job for free" 400 \
    "$(code POST /rpc/ensure_job "{\"z\":$Z,\"x\":$X,\"y\":$Y}" "$OTHER_JWT")"
is "the owner can open a job" 200 \
    "$(code POST /rpc/ensure_job "{\"z\":$Z,\"x\":$X,\"y\":$Y}" "$OWNER_JWT")"
JOB=$(tr -d '"' < "$body")
is "ensure_job is idempotent" "$JOB" \
    "$(code POST /rpc/ensure_job "{\"z\":$Z,\"x\":$X,\"y\":$Y}" "$OWNER_JWT" > /dev/null; tr -d '"' < "$body")"

is "anon cannot claim work" 401 "$(code POST /rpc/claim_atom '{"caps":{}}')"
# claim_for, not claim_atom: claim_atom hands out the best-ranked atom in the
# whole world, and on a database that has just run the torture suite that is
# somebody else's tile. The pool's own call takes the job this test opened.
is "a player can claim an atom" 200 \
    "$(code POST /rpc/claim_for "{\"job_id\":$JOB,\"caps\":{\"webgpu\":true,\"vram_gb\":8}}" "$OWNER_JWT")"
# Since db/0016_sample.sql a z14 job starts with the assemble atom: the
# baseline tile is built from the world, not merged from children it has none of.
grep -q '"op" *: *"assemble"' "$body" && ok "the claimed atom is the assemble" \
    || no "the claimed atom is the assemble ($(head -c 120 "$body"))"
ATOM=$(sed 's/.*"id":\([0-9]*\).*/\1/' "$body")
is "heartbeat on my claim" 204 "$(code POST /rpc/heartbeat "{\"atom_id\":$ATOM}" "$OWNER_JWT")"

echo "# $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
