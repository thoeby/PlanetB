#!/usr/bin/env bash
# WP2.1 — cuts a region's terrain into /geo/dem/{z}/{x}/{y}.r16 and
# registers each tile as an artifact of kind `dem`.
#
#     set -a; . ./.env; set +a; bash tools/seed-dem.sh
#
# The pilot by default; REGION_GEOJSON names a polygon to cut instead
# (tools/geo-common.sh, tools/seed-ch.sh).
#
# Source, in order of preference:
#   DEM_SRC          any GDAL dataset (a .vrt over swissALTI3D 2 m tiles, say)
#   SWISSALTI_VRT    swissALTI3D laid over Copernicus, finer source wins
#   (default)        Copernicus GLO-30 COGs, read straight off AWS open data
#
# dem-v1 encoding: uint16, 256x256, row-major, north-west first, EPSG:3857,
# elevation_m = value * 0.2 - 500. Two decimetres of vertical resolution over
# -500..12607 m — finer than GLO-30's own accuracy and enough for any land on
# Earth. The file carries no header; this line is the format.
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=tools/geo-common.sh
. tools/geo-common.sh

ALGO=dem-v1
SIZE=${DEM_SIZE:-256}
COP_BASE=${COP_BASE:-https://copernicus-dem-30m.s3.amazonaws.com}
[ -f /etc/ssl/certs/ca-certificates.crt ] && export CURL_CA_BUNDLE=${CURL_CA_BUNDLE:-/etc/ssl/certs/ca-certificates.crt}

work=$(mktemp -d); trap 'rm -rf "$work"' EXIT
geo_mkstore
mkdir -p "$GEO_CACHE"

# ------------------------------------------------------------------- source

# The 1-degree cells the seed's lon/lat envelope touches, as Copernicus names.
# One cell for the pilot; Switzerland's envelope touches 18, of which 14
# actually meet the outline (WP5.1).
cop_cells () {
    read -r w s e n <<< "$(geo_bbox)"
    awk -v w="$w" -v s="$s" -v e="$e" -v n="$n" 'BEGIN {
        for (la = int(s); la <= int(n); la++)
            for (lo = int(w); lo <= int(e); lo++)
                printf "N%02d_00_E%03d_00\n", la, lo;
    }'
}

# DEM_STREAM=1 reads the COGs over HTTP instead of caching them: one tile costs
# a few range requests, a whole seed costs a re-read per tile.
fetch_copernicus () {
    local cell f url
    for cell in $(cop_cells); do
        f="$GEO_CACHE/Copernicus_DSM_COG_10_${cell}_DEM.tif"
        url="$COP_BASE/Copernicus_DSM_COG_10_${cell}_DEM/Copernicus_DSM_COG_10_${cell}_DEM.tif"
        if [ "${DEM_STREAM:-0}" = 1 ]; then echo "/vsicurl/$url"; continue; fi
        if [ ! -s "$f" ]; then
            echo "# fetching $url" >&2
            curl -sSf -o "$f.part" "$url" || { rm -f "$f.part"; echo "not ok - $url unreachable" >&2; return 1; }
            mv "$f.part" "$f"
        fi
        echo "$f"
    done
}

if [ -n "${DEM_SRC:-}" ]; then
    src=$DEM_SRC
else
    mapfile -t cells < <(fetch_copernicus)
    [ "${#cells[@]}" -gt 0 ] || { echo "not ok - no DEM source"; exit 1; }
    # swissALTI3D is the finer source and goes last: gdalbuildvrt lets later
    # sources win where they overlap.
    [ -n "${SWISSALTI_VRT:-}" ] && cells+=("$SWISSALTI_VRT")
    src="$work/src.vrt"
    gdalbuildvrt -q -resolution highest "$src" "${cells[@]}"
    gdalinfo "$src" | grep -q '^Band 1' \
        || { echo "not ok - the DEM source mosaic has no bands"; exit 1; }
fi

# Metres to dem-v1 counts, once, as a VRT: every tile then warps in one pass.
scaled="$work/scaled.vrt"
gdal_translate -q -of VRT -ot UInt16 -scale -500 12607 0 65535 "$src" "$scaled"

# --------------------------------------------------------------------- tiles

n=0; skipped=0
: > "$work/registered"
while read -r z x y; do
    dest=$(geo_store_path dem "$z" "$x" "$y" r16)
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
        -ts "$SIZE" "$SIZE" -r cubic -of EHdr "$scaled" "$work/t.bil"
    grep -qiE '^byteorder +i' "$work/t.hdr" \
        || { echo "not ok - EHdr wrote big-endian samples"; exit 1; }
    geo_place "$work/t.bil" "$dest"
    echo "$(sha256sum "$dest" | cut -d' ' -f1) $(stat -c%s "$dest")" >> "$work/registered"
    n=$((n + 1))
done < <(geo_tiles)

[ -s "$work/registered" ] && geo_register dem "$ALGO" < "$work/registered"
echo "# seed-dem: $n tiles cut, $skipped already present, ${SIZE}x${SIZE} uint16, $ALGO"
