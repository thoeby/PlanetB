#!/usr/bin/env bash
# WP2.1 — cuts the pilot region's imagery into /geo/ortho/{z}/{x}/{y}.webp and
# registers each tile as an artifact of kind `ortho`.
#
#     set -a; . ./.env; set +a; bash tools/seed-ortho.sh
#
# Source, in order of preference:
#   ORTHO_SRC   any GDAL dataset (a .vrt over swissimage 2 m tiles, say)
#   (default)   Sentinel-2 L2A true colour, 10 m, from AWS open data: the least
#               cloudy scene of $S2_YEAR/$S2_MONTH over the pilot's MGRS square
#
# ortho-v1: 512x512 lossy WebP, EPSG:3857, north-west first. 512 px over a z14
# tile is 3.3 m/px, so swissimage's 2 m is the better source where it can be
# reached; Sentinel-2 is what a box with only AWS open data gets.
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=tools/geo-common.sh
. tools/geo-common.sh

ALGO=ortho-v1
SIZE=${ORTHO_SIZE:-512}
QUALITY=${ORTHO_QUALITY:-85}
S2_BASE=${S2_BASE:-https://sentinel-cogs.s3.us-west-2.amazonaws.com}
S2_SQUARE=${S2_SQUARE:-32/T/MT}
S2_YEAR=${S2_YEAR:-2025}
S2_MONTH=${S2_MONTH:-7}
[ -f /etc/ssl/certs/ca-certificates.crt ] && export CURL_CA_BUNDLE=${CURL_CA_BUNDLE:-/etc/ssl/certs/ca-certificates.crt}

work=$(mktemp -d); trap 'rm -rf "$work"' EXIT
geo_mkstore
mkdir -p "$GEO_CACHE"

# ------------------------------------------------------------------- source

# Every scene of the month over the square, with its STAC cloud cover; least
# cloudy first. One HTTP GET per scene, of a few kilobytes each.
s2_scenes () {
    local prefix=sentinel-s2-l2a-cogs/$S2_SQUARE/$S2_YEAR/$S2_MONTH/ scene name cc
    for scene in $(curl -sSf --max-time 60 "$S2_BASE/?list-type=2&prefix=$prefix&delimiter=/" \
                   | tr '<' '\n' | sed -n 's|^Prefix>'"$prefix"'\(.*\)/$|\1|p'); do
        name=${scene%/}
        cc=$(curl -sSf --max-time 60 "$S2_BASE/$prefix$name/$name.json" \
             | tr ',' '\n' | sed -n 's/.*"eo:cloud_cover": *\([0-9.]*\).*/\1/p' | head -1)
        [ -n "$cc" ] && echo "$cc $prefix$name/TCI.tif"
    done | sort -g
}

if [ -n "${ORTHO_SRC:-}" ]; then
    src=$ORTHO_SRC
else
    read -r cloud key <<< "$(s2_scenes | head -1)"
    [ -n "${key:-}" ] || { echo "not ok - no Sentinel-2 scene for $S2_SQUARE $S2_YEAR/$S2_MONTH"; exit 1; }
    src="$GEO_CACHE/$(basename "$(dirname "$key")").tif"
    # ORTHO_STREAM=1 reads the scene over HTTP instead of caching 90 MB of it.
    if [ "${ORTHO_STREAM:-0}" = 1 ]; then src="/vsicurl/$S2_BASE/$key"; fi
    if [ ! -s "$src" ] && [ "${ORTHO_STREAM:-0}" != 1 ]; then
        echo "# fetching $S2_BASE/$key (${cloud}% cloud)" >&2
        curl -sSf -o "$src.part" "$S2_BASE/$key" || { rm -f "$src.part"; echo "not ok - $key unreachable"; exit 1; }
        mv "$src.part" "$src"
    fi
fi

# --------------------------------------------------------------------- tiles

n=0; skipped=0
: > "$work/registered"
while read -r z x y; do
    dest=$(geo_store_path ortho "$z" "$x" "$y" webp)
    # A file already in the store is still registered: a run interrupted before
    # geo_register left the store ahead of the database, and register_artifact
    # is idempotent, so re-registering is how the two are brought back level.
    if [ -s "$dest" ] && [ "${FORCE:-0}" != 1 ]; then
        skipped=$((skipped + 1))
        echo "$(sha256sum "$dest" | cut -d' ' -f1) $(stat -c%s "$dest")" >> "$work/registered"
        continue
    fi
    read -r xmin ymin xmax ymax <<< "$(geo_bounds "$z" "$x" "$y")"
    gdalwarp -q -overwrite -t_srs EPSG:3857 -te "$xmin" "$ymin" "$xmax" "$ymax" \
        -ts "$SIZE" "$SIZE" -r cubic -ot Byte "$src" "$work/t.tif"
    # The WebP driver is CreateCopy-only, so the warp lands in a GeoTIFF first.
    gdal_translate -q -of WEBP -co QUALITY="$QUALITY" "$work/t.tif" "$work/t.webp"
    geo_place "$work/t.webp" "$dest"
    echo "$(sha256sum "$dest" | cut -d' ' -f1) $(stat -c%s "$dest")" >> "$work/registered"
    n=$((n + 1))
done < <(geo_tiles)

[ -s "$work/registered" ] && geo_register ortho "$ALGO" < "$work/registered"
echo "# seed-ortho: $n tiles cut, $skipped already present, ${SIZE}x${SIZE} webp q$QUALITY, $ALGO"
