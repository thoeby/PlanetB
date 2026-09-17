#!/usr/bin/env bash
# The player-run's test data: OSM shapes over the same 4 x 4 km as the DEM.
#
# TASKS-foundation.md FND.0. Three layers, named and tagged the way OSM is,
# because the vocabulary is OSM (PLAN-foundation.md D7): a player pastes them
# into their own QGIS project and they need no translation.
#
#   lines   highway, railway, barrier, waterway
#   areas   building, landuse, natural
#   points  natural=tree
#
#   bash tools/make-seed-osm.sh          # writes infra/seed/osm-visp.gpkg
#   FORCE=1 bash tools/make-seed-osm.sh  # fetches it again
#
# Overpass is the source. Where a machine cannot reach it — this container's
# egress policy denies overpass-api.de, its mirrors and Geofabrik both — the
# script writes a STAND-IN of the same shape instead and says so on every run.
# A story that passed against the stand-in has passed against the stand-in
# only, exactly as HANDOFF.md says of the GeoServer fixture.
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
out=${OUT:-$here/infra/seed/osm-visp.gpkg}

# The DEM cutout of tools/make-seed-dem.sh, to the metre.
west=7.8545 east=7.9085 south=46.2759 north=46.3119

if [ -s "$out" ] && [ -z "${FORCE:-}" ]; then
    echo "make-seed-osm: $out is already here (FORCE=1 to fetch it again)"
    exit 0
fi

command -v ogr2ogr > /dev/null || {
    echo "make-seed-osm: ogr2ogr is not installed (Debian/Ubuntu: gdal-bin)" >&2
    exit 1
}

mkdir -p "$(dirname "$out")"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

bbox="$south,$west,$north,$east"
query="[out:xml][timeout:90];
(
  way[highway]($bbox); way[railway]($bbox); way[barrier]($bbox); way[waterway]($bbox);
  way[building]($bbox); way[landuse]($bbox); way[natural]($bbox);
  node[natural=tree]($bbox);
);
(._;>;);
out body;"

mirrors=${OVERPASS_URLS:-https://overpass-api.de/api/interpreter https://overpass.kumi.systems/api/interpreter}
got=
for url in $mirrors; do
    echo "make-seed-osm: asking $url"
    if curl -sS --max-time 180 -d "$query" -o "$tmp/osm.xml" "$url" && [ -s "$tmp/osm.xml" ]; then
        got=$url; break
    fi
done

if [ -n "$got" ]; then
    # OSM_USE_CUSTOM_INDEXING=NO keeps the driver from writing a scratch index
    # next to the input; the extract is small enough to hold in memory.
    export OSM_USE_CUSTOM_INDEXING=NO
    ogr2ogr -f GPKG "$tmp/osm.gpkg" "$tmp/osm.xml" lines -nln lines \
        -select "highway,railway,barrier,waterway,name,width,lanes,surface,bridge,tunnel,lit,oneway"
    ogr2ogr -f GPKG -update -append "$tmp/osm.gpkg" "$tmp/osm.xml" multipolygons -nln areas \
        -select "building,landuse,natural,name,height,leaf_type,leaf_cycle"
    ogr2ogr -f GPKG -update -append "$tmp/osm.gpkg" "$tmp/osm.xml" points -nln points \
        -where "natural = 'tree'" -select "natural,genus,species,leaf_type,height"
    mv "$tmp/osm.gpkg" "$out"
    echo "make-seed-osm: $out — real OSM, from $got"
else
    echo "make-seed-osm: no Overpass mirror answered; writing the STAND-IN instead." >&2
    python3 "$here/tools/make-seed-osm-standin.py" "$tmp/standin.geojson"
    ogr2ogr -f GPKG "$tmp/osm.gpkg" "$tmp/standin.geojson" -nln lines -nlt LINESTRING \
        -sql "SELECT * FROM standin WHERE layer = 'lines'"
    ogr2ogr -f GPKG -update -append "$tmp/osm.gpkg" "$tmp/standin.geojson" -nln areas -nlt POLYGON \
        -sql "SELECT * FROM standin WHERE layer = 'areas'"
    ogr2ogr -f GPKG -update -append "$tmp/osm.gpkg" "$tmp/standin.geojson" -nln points -nlt POINT \
        -sql "SELECT * FROM standin WHERE layer = 'points'"
    mv "$tmp/osm.gpkg" "$out"
    echo "make-seed-osm: $out — STAND-IN, not real OSM (see the head of this script)"
fi
ogrinfo -so "$out" | sed -n '2,20p'
