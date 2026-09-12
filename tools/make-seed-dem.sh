#!/usr/bin/env bash
# The player-run's ground: a 4 x 4 km DEM cutout around Visp, in Valais.
#
# Copernicus GLO-30 is open data on AWS and the one tile that covers Visp is
# a COG, so the clip is a range read, not a 3 GB download. The result is
# committed-size (about 1 MB) but not committed: it is fetched once and cached,
# and every later run finds it on disk.
#
#   bash tools/make-seed-dem.sh          # writes infra/seed/dem-visp.tif
#   FORCE=1 bash tools/make-seed-dem.sh  # re-cuts it
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
out=${OUT:-$here/infra/seed/dem-visp.tif}

# Visp church tower, 46.2939 N 7.8815 E, and 2 km in each direction. One
# degree of latitude is 111.32 km; a degree of longitude here is that times
# cos(46.2939).
west=7.8545 east=7.9085 south=46.2759 north=46.3119

tile=Copernicus_DSM_COG_10_N46_00_E007_00_DEM
src=/vsicurl/https://copernicus-dem-30m.s3.amazonaws.com/$tile/$tile.tif

if [ -s "$out" ] && [ -z "${FORCE:-}" ]; then
    echo "make-seed-dem: $out is already cut (FORCE=1 to re-cut)"
    exit 0
fi

command -v gdalwarp > /dev/null || {
    echo "make-seed-dem: gdalwarp is not installed (Debian/Ubuntu: gdal-bin)" >&2
    exit 1
}

mkdir -p "$(dirname "$out")"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# -te in the source's own CRS (GLO-30 is EPSG:4326), so nothing is reprojected
# and the samples are the ones Copernicus published.
GDAL_DISABLE_READDIR_ON_OPEN=EMPTY_DIR \
CPL_VSIL_CURL_ALLOWED_EXTENSIONS=.tif \
gdalwarp -q -overwrite \
    -te "$west" "$south" "$east" "$north" -te_srs EPSG:4326 \
    -co COMPRESS=DEFLATE -co TILED=YES \
    "$src" "$tmp/dem.tif"

mv "$tmp/dem.tif" "$out"
gdalinfo -stats "$out" | sed -n '1,8p;/Minimum=/p'
echo "make-seed-dem: $out"
