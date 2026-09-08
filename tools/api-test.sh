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
db-uri = "postgres://authenticator:${AUTHENTICATOR_PASSWORD:-authenticator}@${PGHOST:-localhost}:${PGPORT:-5432}/${PGDATABASE:-splatworld}"
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
AREA=$($PSQL -c "INSERT INTO area (geom, owner_id, detail) VALUES (
    st_makeenvelope(7.4, 46.4, 7.6, 46.6, 4326), '$OWNER_ID', 14) RETURNING id")

# ------------------------------------------------------------------- reads
is "anon can read tiles" 200 "$(code GET /tile)"
is "anon can read the catalog" 200 "$(code GET /asset)"
is "anon can read areas" 200 "$(code GET /area)"

# ------------------------------------------------------------------- writes
GEOM=$($PSQL -c "SELECT encode(st_asewkb(st_geomfromtext(
    'POLYGONZ((7.45 46.45 0,7.55 46.45 0,7.55 46.55 0,7.45 46.55 0,7.45 46.45 0))',
    4326)), 'hex')")
FEATURE="{\"area_id\":\"$AREA\",\"kind\":\"forest\",\"geom\":\"$GEOM\"}"
is "anon cannot write a feature" 401 "$(code POST /feature "$FEATURE")"
is "a stranger cannot write in my area" 403 "$(code POST /feature "$FEATURE" "$OTHER_JWT")"
is "the owner can write in their area" 201 "$(code POST /feature "$FEATURE" "$OWNER_JWT")"

# --------------------------------------------------------------------- jobs
TILE=$($PSQL -c "SELECT json_build_object('z', z, 'x', x, 'y', y)::text FROM tile WHERE z = 14 ORDER BY x, y LIMIT 1")
Z=$(echo "$TILE" | sed 's/.*"z" : \([0-9]*\).*/\1/')
X=$(echo "$TILE" | sed 's/.*"x" : \([0-9]*\).*/\1/')
Y=$(echo "$TILE" | sed 's/.*"y" : \([0-9]*\).*/\1/')

is "a stranger cannot open a job for free" 400 \
    "$(code POST /rpc/ensure_job "{\"z\":$Z,\"x\":$X,\"y\":$Y}" "$OTHER_JWT")"
is "the owner can open a job" 200 \
    "$(code POST /rpc/ensure_job "{\"z\":$Z,\"x\":$X,\"y\":$Y}" "$OWNER_JWT")"
JOB=$(tr -d '"' < "$body")
is "ensure_job is idempotent" "$JOB" \
    "$(code POST /rpc/ensure_job "{\"z\":$Z,\"x\":$X,\"y\":$Y}" "$OWNER_JWT" > /dev/null; tr -d '"' < "$body")"

is "anon cannot claim work" 401 "$(code POST /rpc/claim_atom '{"caps":{}}')"
is "a player can claim an atom" 200 \
    "$(code POST /rpc/claim_atom '{"caps":{"webgpu":true,"vram_gb":8}}' "$OWNER_JWT")"
grep -q '"op" *: *"merge"' "$body" && ok "the claimed atom is the merge" \
    || no "the claimed atom is the merge ($(head -c 120 "$body"))"
ATOM=$(sed 's/.*"id":\([0-9]*\).*/\1/' "$body")
is "heartbeat on my claim" 204 "$(code POST /rpc/heartbeat "{\"atom_id\":$ATOM}" "$OWNER_JWT")"

echo "# $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
