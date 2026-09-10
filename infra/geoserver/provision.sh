#!/usr/bin/env bash
# WP0.11 — provisions the GeoServer workspace, PostGIS store, layers and styles
# over the REST API. Idempotent: re-running it is a no-op on existing objects.
# GeoServer is admin and visualisation only; it is never the app API (Inv. 9).
set -euo pipefail

GS=${GEOSERVER_URL:-http://localhost:8081/geoserver}
GS_USER=${GEOSERVER_ADMIN_USER:-admin}
GS_PASS=${GEOSERVER_ADMIN_PASSWORD:-geoserver}
DB_HOST=${GEOSERVER_DB_HOST:-db}
DB_PORT=${PGPORT:-5432}
DB_NAME=${PGDATABASE:-splatworld}
DB_USER=${GEOSERVER_DB_USER:-geoserver}
DB_PASS=${GEOSERVER_DB_PASSWORD:-geoserver}
WS=splatworld
HERE=$(cd "$(dirname "$0")" && pwd)

gs () { # method path [body] [content-type]
    local args=(-sS -u "$GS_USER:$GS_PASS" -X "$1" "$GS$2"
                -H "Content-Type: ${4:-application/xml}" -o /dev/null -w '%{http_code}')
    [ -n "${3:-}" ] && args+=(--data-binary "@$3")
    local code; code=$(curl "${args[@]}")
    echo "$code $1 $2"
    # 2xx created or changed it, 401/409 mean it is already there (re-run).
    case $code in 2??|401|409) ;; *) echo "provision: unexpected $code" >&2; return 1 ;; esac
}

tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT

echo "<workspace><name>$WS</name></workspace>" > "$tmp/ws.xml"
gs POST /rest/workspaces "$tmp/ws.xml"

# GeoServer connection parameter keys contain spaces, so the stores are sent
# as JSON rather than XML. Two stores: the tables in `public` that QGIS draws
# into (a table has a primary key, so GeoTools serves it writable with nothing
# further configured — a view does not, and comes out read-only), and the
# read-only tile overview in `gis`.
store() {  # name schema
cat > "$tmp/store.json" <<JSON
{"dataStore":{"name":"$1","connectionParameters":{"entry":[
 {"@key":"host","\$":"$DB_HOST"},{"@key":"port","\$":"$DB_PORT"},
 {"@key":"database","\$":"$DB_NAME"},{"@key":"user","\$":"$DB_USER"},
 {"@key":"passwd","\$":"$DB_PASS"},{"@key":"dbtype","\$":"postgis"},
 {"@key":"schema","\$":"$2"},{"@key":"Expose primary keys","\$":"true"},
 {"@key":"validate connections","\$":"true"}]}}}
JSON
gs POST "/rest/workspaces/$WS/datastores" "$tmp/store.json" application/json
}
store splatworld_pg public
store splatworld_gis gis

layer() {  # store name
    printf '<featureType><name>%s</name><srs>EPSG:4326</srs></featureType>' "$2" \
        > "$tmp/ft.xml"
    gs POST "/rest/workspaces/$WS/datastores/$1/featuretypes" "$tmp/ft.xml"
}
for l in area feature instance; do layer splatworld_pg "$l"; done
layer splatworld_gis tile

for style in tile area; do
    gs POST "/rest/workspaces/$WS/styles?name=$style" \
        "$HERE/styles/$style.sld" application/vnd.ogc.sld+xml
    printf '<layer><defaultStyle><name>%s:%s</name></defaultStyle></layer>' "$WS" "$style" \
        > "$tmp/layer.xml"
    gs PUT "/rest/layers/$WS:$style" "$tmp/layer.xml"
done

# WFS-T: transactions need service level COMPLETE.
cat > "$tmp/wfs.xml" <<'XML'
<wfs><enabled>true</enabled><serviceLevel>COMPLETE</serviceLevel>
     <maxFeatures>50000</maxFeatures></wfs>
XML
gs PUT /rest/services/wfs/settings "$tmp/wfs.xml"

echo "provisioned. WFS-T endpoint: $GS/$WS/wfs"
