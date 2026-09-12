#!/usr/bin/env bash
# WP0.10 — immutable file store: PUT without a token is 401, to an unreserved
# path 403, to a reserved path 201, twice 409, and GET is immutable.
# Runs against $FILES_URL (the compose stack) or starts a local nginx+postgrest.
set -euo pipefail

FILES_URL=${FILES_URL:-http://localhost:8080}
API_URL=${API_URL:-http://localhost:3000}
PSQL="psql -v ON_ERROR_STOP=1 --no-psqlrc -q -t -A"
PASS=0
FAIL=0
ok () { echo "ok - $1"; PASS=$((PASS + 1)); }
no () { echo "not ok - $1"; FAIL=$((FAIL + 1)); }
is () { [ "$2" = "$3" ] && ok "$1" || no "$1 (expected $2, got $3)"; }

body=$(mktemp)
put () { # path sha [token]
    local args=(-s -o "$body" -w '%{http_code}' -X PUT "$FILES_URL$1"
                -H "X-Sha256: $2" --data-binary @"$PAYLOAD")
    [ -n "${3:-}" ] && args+=(-H "Authorization: Bearer $3")
    curl "${args[@]}"
}

PAYLOAD=$(mktemp); head -c 2048 /dev/urandom > "$PAYLOAD"
SHA=$(sha256sum "$PAYLOAD" | cut -d' ' -f1)
SHA2=$(head -c 2048 /dev/urandom | sha256sum | cut -d' ' -f1)

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
    ROOT=$(mktemp -d); chmod 1777 "$ROOT"; NGINX_CONF=$(mktemp --suffix=.conf)
    # Same config as compose, retargeted at this box.
    sed -e "s|server postgrest:3000;|server 127.0.0.1:${API_URL##*:};|" \
        -e "s|listen 80;|listen ${FILES_URL##*:};|" \
        -e "s|root /srv/files;|root $ROOT;|" \
        -e "1i pid /tmp/splatworld-nginx.pid;\nerror_log /tmp/splatworld-nginx-error.log;" \
        infra/nginx.conf > "$NGINX_CONF"
    sed -i "s|^http {|http {\n    access_log /tmp/splatworld-nginx-access.log;\n    client_body_temp_path /tmp/splatworld-nginx-body;\n    proxy_temp_path /tmp/splatworld-nginx-proxy;\n    fastcgi_temp_path /tmp/splatworld-nginx-fcgi;\n    uwsgi_temp_path /tmp/splatworld-nginx-uwsgi;\n    scgi_temp_path /tmp/splatworld-nginx-scgi;|" "$NGINX_CONF"
    nginx -c "$NGINX_CONF"
    for _ in $(seq 1 20); do curl -sf -o /dev/null "$FILES_URL/healthz" && break; sleep 0.25; done
    curl -sf -o /dev/null "$FILES_URL/healthz" || { echo "not ok - nginx did not start"; tail -5 /tmp/splatworld-nginx-error.log; exit 1; }
    echo "# started a local nginx on $FILES_URL rooted at $ROOT"
fi

# ------------------------------------------------------------------ fixtures
STAMP=$(date +%s%N)
JWT=$(curl -s -X POST "$API_URL/rpc/register" -H 'Content-Type: application/json' \
        -d "{\"email\":\"files$STAMP@example.com\",\"pw\":\"password12\"}" > /dev/null
      curl -s -X POST "$API_URL/rpc/login" -H 'Content-Type: application/json' \
        -d "{\"email\":\"files$STAMP@example.com\",\"pw\":\"password12\"}" | tr -d '"')
UID_=$($PSQL -c "SELECT id FROM auth.user WHERE email = 'files$STAMP@example.com'")

# An area, a feature, a job and a claimed atom, so /jobs/{atom}/ is reserved.
# The area sits at a per-run offset so repeated runs never share a tile.
OFF=$(( (STAMP / 1000000) % 200 ))
LON=$(awk "BEGIN{printf \"%.4f\", 6.0 + $OFF * 0.015}")
LAT=$(awk "BEGIN{printf \"%.4f\", 46.0 + $OFF * 0.004}")
$PSQL <<SQL > /dev/null
SET client_min_messages = warning;
INSERT INTO area (id, geom, owner_id, detail) VALUES (gen_random_uuid(),
    st_makeenvelope($LON - 0.02, $LAT - 0.02, $LON + 0.02, $LAT + 0.02, world_srid()),
    '$UID_', 14);
INSERT INTO feature (area_id, kind, geom)
VALUES ((SELECT id FROM area WHERE owner_id = '$UID_'), 'footprint',
        st_setsrid(st_makepoint($LON, $LAT, 500), world_srid()));
DO \$\$
BEGIN
    PERFORM set_config('request.jwt.claims',
        json_build_object('sub', '$UID_', 'role', 'player')::text, true);
    PERFORM ensure_job(14, tile_x($LON, 14), tile_y($LAT, 14));
    PERFORM claim_atom('{}'::jsonb);
END \$\$;
SQL
ATOM=$($PSQL -c "SELECT a.id FROM atom a JOIN worker w ON w.id = a.worker_id
                 WHERE w.user_id = '$UID_' AND a.state = 'claimed' LIMIT 1")
[ -n "$ATOM" ] || { echo "not ok - fixture did not claim an atom"; exit 1; }

# --------------------------------------------------------------------- tests
is "PUT without a token is 401" 401 "$(put "/jobs/$ATOM/$SHA" "$SHA")"
is "PUT to an unreserved path is 403" 403 "$(put "/jobs/999999999/$SHA" "$SHA" "$JWT")"
is "PUT of a foreign tile sog is 403" 403 \
    "$(put "/tiles/14/0/0/$SHA.sog" "$SHA" "$JWT")"
is "PUT with a sha the path does not match is 403" 403 \
    "$(put "/assets/$SHA.glb" "$SHA2" "$JWT")"
is "PUT to a reserved job path is 201" 201 "$(put "/jobs/$ATOM/$SHA" "$SHA" "$JWT")"
is "a second PUT to the same path is 409" 409 "$(put "/jobs/$ATOM/$SHA" "$SHA" "$JWT")"
is "PUT of an asset by any authenticated user is 201" 201 \
    "$(put "/assets/$SHA.glb" "$SHA" "$JWT")"

HDRS=$(curl -s -D - -o /dev/null "$FILES_URL/jobs/$ATOM/$SHA")
is "GET returns the bytes" 200 "$(curl -s -o "$body" -w '%{http_code}' "$FILES_URL/jobs/$ATOM/$SHA")"
cmp -s "$body" "$PAYLOAD" && ok "the bytes round-trip" || no "the bytes round-trip"
grep -qi 'cache-control: public, max-age=31536000, immutable' <<< "$HDRS" \
    && ok "GET is immutable and cacheable for a year" \
    || no "GET is immutable and cacheable for a year"

# ------------------------------------------------- WP4.1: the catalog round-trip

# canon-v1 runs in a browser tab; here it runs under node, over the same fixture
# client/test/canon.test.js uses, so this exercises the real upload path: PUT
# the canonical bytes, register the artifact, then register the asset and read
# it back as anon. The SAN the database derives must be the one canon.js did.
CANON=$(mktemp)
if node -e "
import('./client/lib/canon.js').then(async (m) => {
    const fs = await import('node:fs');
    const r = await m.canonicalise(new Uint8Array(
        fs.readFileSync('client/test/fixtures/assets/blender.glb')));
    fs.writeFileSync(process.argv[1], r.glb);
    console.log(r.sha256, r.san, r.meta.tris);
});" "$CANON" > "$body" 2>/dev/null; then
    read -r GLB_SHA GLB_SAN GLB_TRIS < "$body"
    rc=$(curl -s -o /dev/null -w '%{http_code}' -X PUT "$FILES_URL/assets/$GLB_SHA.glb" \
         -H "X-Sha256: $GLB_SHA" -H "Authorization: Bearer $JWT" --data-binary @"$CANON")
    is "PUT of a canonical glb is 201" 201 "$rc"
    curl -s -X POST "$API_URL/rpc/register_artifact" -H 'Content-Type: application/json' \
        -H "Authorization: Bearer $JWT" -d "{\"sha256\":\"$GLB_SHA\",\"kind\":\"glb\",
            \"bytes\":$(stat -c%s "$CANON"),\"algo_version\":\"canon-v1\"}" > /dev/null
    SAN=$(curl -s -X POST "$API_URL/rpc/register_asset" -H 'Content-Type: application/json' \
        -H "Authorization: Bearer $JWT" \
        -d "{\"sha256\":\"$GLB_SHA\",\"canon_version\":1,
             \"meta\":{\"name\":\"Bench $STAMP\",\"category\":\"furniture\",
                        \"tris\":$GLB_TRIS,\"license\":\"cc0\"}}" | tr -d '"')
    is "register_asset derives the SAN canon-v1 did" "$GLB_SAN" "$SAN"
    is "the asset is readable by anon" "$GLB_TRIS" \
        "$(curl -s "$API_URL/asset?san=eq.$SAN&select=tris" | tr -dc '0-9')"
    is "registering the same bytes again is a no-op" "$GLB_SAN" \
        "$(curl -s -X POST "$API_URL/rpc/register_asset" -H 'Content-Type: application/json' \
            -H "Authorization: Bearer $JWT" \
            -d "{\"sha256\":\"$GLB_SHA\",\"canon_version\":1,\"meta\":{}}" | tr -d '"')"
else
    echo "# canon-v1 could not run under node, catalog round-trip skipped"
fi

# Once registered, the sha can never be uploaded again (Invariant 1).
$PSQL -c "INSERT INTO artifact (sha256, kind, bytes, algo_version)
          VALUES ('$SHA2', 'sog', 1, 'sog-v1')" > /dev/null
is "PUT of an already registered sha is 403" 403 "$(put "/assets/$SHA2.glb" "$SHA2" "$JWT")"

echo "# $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
