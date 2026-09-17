#!/usr/bin/env bash
# The player-run's ground cover: two sources over the same 4 x 4 km as the DEM.
#
# TASKS-foundation.md FND.0, PLAN-foundation.md D8. Land cover is natural
# cover from outside sources, mapped by an admin onto the OSM vocabulary:
#
#   infra/seed/tlm-visp.gpkg       swissTLM3D Bodenbedeckung, a styled vector
#   infra/seed/worldcover-visp.tif ESA WorldCover 10 m, already a class raster
#
# WorldCover is open data on AWS and one 3 x 3 degree tile covers Visp, so the
# clip is a range read. swisstopo is a STAC download and this container's
# egress policy denies data.geo.admin.ch; where it cannot be reached the
# script writes a STAND-IN of the same shape and says so on every run. A story
# that passed against the stand-in has passed against the stand-in only.
#
#   bash tools/make-seed-cover.sh          # writes both
#   FORCE=1 bash tools/make-seed-cover.sh  # fetches them again
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
seed=${SEED_DIR:-$here/infra/seed}
tlm=$seed/tlm-visp.gpkg
wc_out=$seed/worldcover-visp.tif

west=7.8545 east=7.9085 south=46.2759 north=46.3119

command -v gdalwarp > /dev/null || {
    echo "make-seed-cover: gdalwarp is not installed (Debian/Ubuntu: gdal-bin)" >&2
    exit 1
}
mkdir -p "$seed"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# ------------------------------------------------------- ESA WorldCover 10 m

if [ -s "$wc_out" ] && [ -z "${FORCE:-}" ]; then
    echo "make-seed-cover: $wc_out is already cut (FORCE=1 to re-cut)"
else
    base=https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map
    src=/vsicurl/$base/ESA_WorldCover_10m_2021_v200_N45E006_Map.tif
    # Nearest neighbour: these are class codes, and an average of two classes
    # is a class that does not exist.
    GDAL_DISABLE_READDIR_ON_OPEN=EMPTY_DIR \
    CPL_VSIL_CURL_ALLOWED_EXTENSIONS=.tif \
    gdalwarp -q -overwrite -r near \
        -te "$west" "$south" "$east" "$north" -te_srs EPSG:4326 \
        -co COMPRESS=DEFLATE -co TILED=YES \
        "$src" "$tmp/worldcover.tif"
    mv "$tmp/worldcover.tif" "$wc_out"
    echo "make-seed-cover: $wc_out — real ESA WorldCover 2021 v200"
fi

# --------------------------------------------------- swissTLM3D Bodenbedeckung

if [ -s "$tlm" ] && [ -z "${FORCE:-}" ]; then
    echo "make-seed-cover: $tlm is already here (FORCE=1 to fetch it again)"
    exit 0
fi

stac=${TLM_URL:-https://data.geo.admin.ch/api/stac/v0.9/collections/ch.swisstopo.swisstlm3d-bodenbedeckung/items}
if curl -sS --max-time 120 -o "$tmp/items.json" "$stac" 2> /dev/null \
        && [ -s "$tmp/items.json" ]; then
    href=$(python3 -c "
import json, sys
d = json.load(open(sys.argv[1]))
for it in d.get('features', []):
    for a in it.get('assets', {}).values():
        if a.get('href', '').endswith('.gpkg.zip') or a.get('href', '').endswith('.gpkg'):
            print(a['href']); raise SystemExit
" "$tmp/items.json")
    [ -n "$href" ] || { echo "make-seed-cover: swisstopo listed no gpkg" >&2; exit 1; }
    curl -sS --max-time 900 -o "$tmp/tlm.zip" "$href"
    ogr2ogr -f GPKG "$tmp/tlm.gpkg" "/vsizip/$tmp/tlm.zip" \
        -spat "$west" "$south" "$east" "$north" -nln bodenbedeckung
    mv "$tmp/tlm.gpkg" "$tlm"
    echo "make-seed-cover: $tlm — real swissTLM3D, from $href"
else
    echo "make-seed-cover: swisstopo did not answer; writing the STAND-IN instead." >&2
    python3 - "$tmp/tlm.geojson" <<'PY'
# swissTLM3D Bodenbedeckung as it is shaped — one polygon layer whose OBJEKTART
# carries the class — over the same ground, by hand. Deterministic.
import json, math, sys

LAT0, LON0 = 46.2939, 7.8815
M_LAT = 1.0 / 111320.0
M_LON = 1.0 / (111320.0 * math.cos(math.radians(LAT0)))


def box(e, n, w, h, objektart):
    w2, h2 = w / 2, h / 2
    ring = [(e - w2, n - h2), (e + w2, n - h2), (e + w2, n + h2),
            (e - w2, n + h2), (e - w2, n - h2)]
    ring = [[round(LON0 + x * M_LON, 7), round(LAT0 + y * M_LAT, 7)] for x, y in ring]
    return {'type': 'Feature', 'properties': {'OBJEKTART': objektart},
            'geometry': {'type': 'Polygon', 'coordinates': [ring]}}


rows = [
    box(-700, 500, 640, 460, 'Wald'),
    box(-120, 900, 300, 240, 'Wald offen'),
    box(-820, 1300, 520, 360, 'Fels'),
    box(-1400, 1500, 500, 400, 'Gletscher'),
    box(260, 760, 300, 220, 'Gebueschwald'),
    box(500, -200, 140, 110, 'Stehende Gewaesser'),
    box(400, 480, 420, 320, 'Uebrige befestigte'),
]
json.dump({'type': 'FeatureCollection', 'name': 'bodenbedeckung',
           'features': rows}, open(sys.argv[1], 'w'), indent=1, sort_keys=True)
print(f'make-seed-cover: {len(rows)} stand-in polygons')
PY
    ogr2ogr -f GPKG "$tmp/tlm.gpkg" "$tmp/tlm.geojson" -nln bodenbedeckung -nlt POLYGON
    mv "$tmp/tlm.gpkg" "$tlm"
    echo "make-seed-cover: $tlm — STAND-IN, not real swissTLM3D"
fi
