#!/usr/bin/env bash
# WP1.2 — runs tools/make-test-tiles.mjs against a live API and file store,
# starting a local postgrest and nginx if nothing is serving them. Unlike
# files-test.sh the file store is rooted at $FILES_ROOT and kept: the tiles it
# writes are what the viewer streams in WP1.3.
set -euo pipefail

API_URL=${API_URL:-http://localhost:3000}
FILES_URL=${FILES_URL:-http://localhost:8080}
FILES_ROOT=${FILES_ROOT:-./infra/files}
export API_URL FILES_URL

cleanup () { [ -n "${NGINX_CONF:-}" ] && nginx -c "$NGINX_CONF" -s quit 2>/dev/null || true
             [ -n "${PGRST_PID:-}" ] && kill "$PGRST_PID" 2>/dev/null || true; }
trap cleanup EXIT

if ! curl -sf -o /dev/null "$API_URL/"; then
    command -v postgrest > /dev/null || { echo "not ok - no API and no postgrest binary"; exit 1; }
    conf=$(mktemp)
    cat > "$conf" <<CONF
db-uri = "postgres://authenticator:${AUTHENTICATOR_PASSWORD:-authenticator}@${PGHOST:-localhost}:${PGPORT:-5432}/${PGDATABASE:-splatworld}"
db-schemas = "api"
db-anon-role = "anon"
jwt-secret = "${JWT_SECRET:?JWT_SECRET must be set}"
server-port = ${API_URL##*:}
CONF
    env -u PGRST_DB_URI -u PGRST_DB_SCHEMAS -u PGRST_DB_ANON_ROLE \
        -u PGRST_JWT_SECRET -u PGRST_SERVER_PORT postgrest "$conf" > /tmp/postgrest.log 2>&1 &
    PGRST_PID=$!
    for _ in $(seq 1 40); do curl -sf -o /dev/null "$API_URL/" && break; sleep 0.25; done
    curl -sf -o /dev/null "$API_URL/" || { echo "not ok - postgrest did not start"; tail -5 /tmp/postgrest.log; exit 1; }
    echo "# started a local postgrest on $API_URL"
fi

if ! curl -sf -o /dev/null "$FILES_URL/healthz"; then
    command -v nginx > /dev/null || { echo "not ok - no file store and no nginx binary"; exit 1; }
    # nginx workers run as www-data; the store has to be writable by them.
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
    curl -sf -o /dev/null "$FILES_URL/healthz" || { echo "not ok - nginx did not start"; tail -5 /tmp/splatworld-nginx-error.log; exit 1; }
    echo "# started a local nginx on $FILES_URL rooted at $ROOT"
fi

node tools/make-test-tiles.mjs
