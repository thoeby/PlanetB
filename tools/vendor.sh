#!/usr/bin/env bash
# Fetches the third-party code client/ loads from a CDN into client/vendor/, so
# the browser tests can run without network access. The vendored copies are
# gitignored: this script, and the pinned versions in it, are the record.
#
# Nothing here changes what a browser loads in production — play.html still
# points at the CDN. The playwright fixture routes that URL to the local copy.
set -euo pipefail

PLAYCANVAS_VERSION=${PLAYCANVAS_VERSION:-2.22.0}
DRACO_VERSION=${DRACO_VERSION:-1.5.7}
OL_VERSION=${OL_VERSION:-10.10.0}
DEST=client/vendor/playcanvas

# Google's Draco codec (Apache-2.0), for the GLBs canon-v1 is handed compressed.
# npm only: there is no CDN copy this repo pins. Without it a Draco GLB is
# refused rather than canonicalised wrongly, and the Draco test skips.
vendor_draco () {
    local dest=client/vendor/draco tmp
    [ -f "$dest/draco3d.js" ] && [ "${FORCE:-}" != "1" ] && {
        echo "vendor: $dest is already here (FORCE=1 to refetch)"; return 0; }
    mkdir -p "$dest"
    tmp=$(mktemp -d)
    ( cd "$tmp" && npm pack "draco3d@${DRACO_VERSION}" --silent > /dev/null ) || {
        echo "vendor: draco3d@${DRACO_VERSION} unreachable, skipping"; rm -rf "$tmp"; return 0; }
    tar xzf "$tmp"/draco3d-*.tgz -C "$tmp"
    cp "$tmp"/package/draco3d.js "$tmp"/package/draco_decoder_nodejs.js \
       "$tmp"/package/draco_encoder_nodejs.js "$tmp"/package/draco_decoder.wasm \
       "$tmp"/package/draco_encoder.wasm "$dest/"
    echo '{"type":"commonjs"}' > "$dest/package.json"
    echo "draco3d ${DRACO_VERSION}, Apache-2.0, https://github.com/google/draco" \
        > "$dest/NOTICE"
    rm -rf "$tmp"
    echo "vendor: draco3d $DRACO_VERSION from npm"
}

# OpenLayers (BSD-2-Clause), the map edit.html draws on. What is fetched is the
# built bundle and its stylesheet, not the ES modules: those import each other
# by bare specifier, and client/ has no bundler to resolve one with.
vendor_ol () {
    local dest=client/vendor/ol tmp url
    [ -f "$dest/ol.js" ] && [ "${FORCE:-}" != "1" ] && {
        echo "vendor: $dest is already here (FORCE=1 to refetch)"; return 0; }
    mkdir -p "$dest"
    url="https://cdn.jsdelivr.net/npm/ol@${OL_VERSION}"
    if curl -sSf -o "$dest/ol.js" "$url/dist/ol.js" 2>/dev/null \
       && curl -sSf -o "$dest/ol.css" "$url/ol.css" 2>/dev/null; then
        echo "vendor: openlayers ${OL_VERSION} from $url"
        return 0
    fi
    # A refused download still leaves an empty file behind, and an empty
    # ol.js is what the next run would take for a vendored copy.
    rm -f "$dest/ol.js" "$dest/ol.css"
    tmp=$(mktemp -d)
    ( cd "$tmp" && npm pack "ol@${OL_VERSION}" --silent > /dev/null ) || {
        echo "vendor: ol@${OL_VERSION} unreachable, skipping"; rm -rf "$tmp"; return 0; }
    tar xzf "$tmp"/ol-*.tgz -C "$tmp"
    cp "$tmp/package/dist/ol.js" "$dest/ol.js"
    cp "$tmp/package/ol.css" "$dest/ol.css"
    cp "$tmp/package/LICENSE.md" "$dest/LICENSE.md"
    rm -rf "$tmp"
    echo "vendor: openlayers ${OL_VERSION} from npm"
}

vendor_draco
vendor_ol

mkdir -p "$DEST"
if [ -f "$DEST/playcanvas.js" ] && [ "${FORCE:-}" != "1" ]; then
    echo "vendor: $DEST/playcanvas.js is already here (FORCE=1 to refetch)"
    exit 0
fi

url="https://code.playcanvas.com/playcanvas-${PLAYCANVAS_VERSION}.js"
if curl -sSf -o "$DEST/playcanvas.js" "$url" 2>/dev/null; then
    echo "vendor: playcanvas $PLAYCANVAS_VERSION from $url"
    exit 0
fi

# The CDN is not always reachable from a build box. The npm package carries the
# same engine build, so fall back to it rather than skipping the browser tests.
echo "vendor: $url unreachable, falling back to npm"
tmp=$(mktemp -d)
( cd "$tmp" && npm pack "playcanvas@${PLAYCANVAS_VERSION}" --silent > /dev/null )
tar xzf "$tmp"/playcanvas-*.tgz -C "$tmp"
cp "$tmp/package/build/playcanvas.js" "$DEST/playcanvas.js"
cp "$tmp/package/LICENSE" "$DEST/LICENSE"
rm -rf "$tmp"
echo "vendor: playcanvas $PLAYCANVAS_VERSION from npm"
