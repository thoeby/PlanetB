#!/usr/bin/env bash
# LV.8 — the registrar: a folder into the world. Registering the same folder
# twice changes nothing; a changed GLB moves `current` and leaves the rights
# that pin a hash where they were (db/0207, db/0209).
# Runs against $API_URL and $FILES_URL, starting a PostgREST and an nginx the
# way tools/files-test.sh does when nothing answers there.
set -euo pipefail

cd "$(dirname "$0")/.."
FILES_URL=${FILES_URL:-http://localhost:8081}
API_URL=${API_URL:-http://localhost:3000}
PSQL="psql -v ON_ERROR_STOP=1 --no-psqlrc -q -t -A"
PASS=0
FAIL=0
ok () { echo "ok - $1"; PASS=$((PASS + 1)); }
no () { echo "not ok - $1"; FAIL=$((FAIL + 1)); }
is () { [ "$2" = "$3" ] && ok "$1" || no "$1 (expected $2, got $3)"; }

cleanup () { [ -n "${NGINX_CONF:-}" ] && nginx -c "$NGINX_CONF" -s quit 2>/dev/null || true
             [ -n "${PGRST_PID:-}" ] && kill "$PGRST_PID" 2>/dev/null || true
             [ -n "${DIR:-}" ] && rm -rf "$DIR"; }
trap cleanup EXIT

if ! curl -sf -o /dev/null "$API_URL/"; then
    conf=$(mktemp)
    cat > "$conf" <<CONF
db-uri = "host='${PGHOST:-localhost}' port='${PGPORT:-5432}' user=authenticator password='${AUTHENTICATOR_PASSWORD:-authenticator}' dbname='${PGDATABASE:-splatworld}'"
db-schemas = "api"
db-anon-role = "anon"
jwt-secret = "${JWT_SECRET:?JWT_SECRET must be set}"
server-port = ${API_URL##*:}
CONF
    env -u PGRST_DB_URI -u PGRST_DB_SCHEMAS -u PGRST_DB_ANON_ROLE \
        -u PGRST_JWT_SECRET -u PGRST_SERVER_PORT postgrest "$conf" > /tmp/postgrest-register.log 2>&1 &
    PGRST_PID=$!
    for _ in $(seq 1 40); do curl -sf -o /dev/null "$API_URL/" && break; sleep 0.25; done
fi
if ! curl -sf -o /dev/null "$FILES_URL/healthz"; then
    ROOT=$(mktemp -d); chmod 1777 "$ROOT"; NGINX_CONF=$(mktemp --suffix=.conf)
    sed -e "s|server postgrest:3000;|server 127.0.0.1:${API_URL##*:};|" \
        -e "s|server node:8095;|server 127.0.0.1:8095;|" \
        -e "s|listen 80;|listen ${FILES_URL##*:};|" \
        -e "s|root /srv/files;|root $ROOT;|" \
        -e "1i pid /tmp/splatworld-nginx-register.pid;\nerror_log /tmp/splatworld-nginx-register.log;" \
        infra/nginx.conf > "$NGINX_CONF"
    sed -i "s|^http {|http {\n    access_log off;\n    client_body_temp_path /tmp/splatworld-nginx-body;\n    proxy_temp_path /tmp/splatworld-nginx-proxy;\n    fastcgi_temp_path /tmp/splatworld-nginx-fcgi;\n    uwsgi_temp_path /tmp/splatworld-nginx-uwsgi;\n    scgi_temp_path /tmp/splatworld-nginx-scgi;|" "$NGINX_CONF"
    nginx -c "$NGINX_CONF"
    for _ in $(seq 1 20); do curl -sf -o /dev/null "$FILES_URL/healthz" && break; sleep 0.25; done
fi

# ------------------------------------------------------------------ a maker
STAMP=$(date +%s%N)
for who in maker keeper; do
    curl -s -X POST "$API_URL/rpc/register" -H 'Content-Type: application/json' \
        -d "{\"email\":\"$who$STAMP@example.com\",\"pw\":\"password12\"}" > /dev/null
done
export SPLATWORLD_EMAIL="maker$STAMP@example.com" SPLATWORLD_PASSWORD=password12
KEEPER=$(curl -s -X POST "$API_URL/rpc/login" -H 'Content-Type: application/json' \
    -d "{\"email\":\"keeper$STAMP@example.com\",\"pw\":\"password12\"}" | tr -d '"')

DIR=$(mktemp -d)
cp client/test/fixtures/assets/rock.glb "$DIR/model.glb"
cp client/flow/samples/file-response.elx "$DIR/flow.elx"
cat > "$DIR/product.json" <<JSON
{"name": "Findling $STAMP", "category": "prop", "licence": "cc0", "price": 0,
 "policy": "pinned", "channel": "current", "needs": {"ports": "own"}}
JSON
reg () { python3 tools/register.py "$DIR" --api "$API_URL" --files "$FILES_URL"; }

# ------------------------------------------------------------------- tests
FIRST=$(reg) && ok "a folder is registered" || no "a folder is registered"
SAN=$(cat "$DIR/.san")
is "and the folder remembers its product" 1 "$(echo "$SAN" | grep -c '^S[A-Z2-7]\{12\}$')"
VERSIONS=$($PSQL -c "SELECT count(*) FROM asset_version WHERE san = '$SAN'")
ARTIFACTS=$($PSQL -c "SELECT count(*) FROM artifact")
SECOND=$(reg)
is "registering the same folder again says the same" "$FIRST" "$SECOND"
is "and records no new version" "$VERSIONS" \
   "$($PSQL -c "SELECT count(*) FROM asset_version WHERE san = '$SAN'")"
is "nor any new file" "$ARTIFACTS" "$($PSQL -c "SELECT count(*) FROM artifact")"
is "the version carries its flow and what it needs" '{"ports": "own"}' \
   "$($PSQL -c "SELECT needs FROM asset_version WHERE san = '$SAN' AND flow_sha256 IS NOT NULL
                ORDER BY id DESC LIMIT 1")"

# Somebody takes a right, which pins this version (the product is sold pinned).
curl -s -X POST "$API_URL/rpc/order_create" -H 'Content-Type: application/json' \
    -H "Authorization: Bearer $KEEPER" -d "{\"san\":\"$SAN\"}" > /dev/null
OLD=$($PSQL -c "SELECT pointer ->> 'current' FROM asset WHERE san = '$SAN'")
cp client/test/fixtures/assets/bush.glb "$DIR/model.glb"
reg > /dev/null
NEW=$($PSQL -c "SELECT pointer ->> 'current' FROM asset WHERE san = '$SAN'")
[ "$NEW" != "$OLD" ] && ok "a changed GLB moves current" || no "a changed GLB moves current"
is "and the right that pins keeps the old hash" "$OLD" \
   "$($PSQL -c "SELECT right_sha('$SAN', (SELECT id FROM auth.user
                                        WHERE email = 'keeper$STAMP@example.com'))")"
echo '{"name": ""}' > "$DIR/product.json"
reg 2> "$DIR/said" && no "an empty name is refused" || ok "an empty name is refused"
is "in words" "register: product.json has no name" "$(cat "$DIR/said")"

echo "# $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
