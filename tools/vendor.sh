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
RAJDHANI_VERSION=${RAJDHANI_VERSION:-5.2.6}
SORA_VERSION=${SORA_VERSION:-5.2.6}
JETBRAINS_VERSION=${JETBRAINS_VERSION:-5.2.6}
THREE_VERSION=${THREE_VERSION:-0.186.0}
BVH_VERSION=${BVH_VERSION:-0.9.15}
PATHTRACER_VERSION=${PATHTRACER_VERSION:-0.0.24}
# The flow editor's canvas, pinned to one upstream commit (TASKS-foundation.md
# FND.1). litegraph publishes no build to npm that matches it, so this is the
# raw file at that commit.
LITEGRAPH_COMMIT=${LITEGRAPH_COMMIT:-0555a2f2a3df5d4657593c6d45eb192359888195}

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

# Helia and libp2p (Apache-2.0/MIT), the tab's own IPFS node (TASKS-live.md
# LV.12), bundled once into one ES module from what `npm install` put in
# node_modules — the client has no bundler, and these import each other by
# bare specifier. Without it a tab is not a peer and reads files by HTTP.
vendor_helia () {
    local dest=client/vendor/helia
    [ -f "$dest/helia.js" ] && [ "${FORCE:-}" != "1" ] && {
        echo "vendor: $dest is already here (FORCE=1 to rebuild)"; return 0; }
    [ -x node_modules/.bin/esbuild ] || {
        echo "vendor: esbuild missing (npm install), helia skipped"; return 0; }
    mkdir -p "$dest"
    node_modules/.bin/esbuild tools/vendor/helia-entry.mjs --bundle --format=esm \
        --platform=browser --minify --log-level=warning --outfile="$dest/helia.js"
    echo "helia/libp2p from node_modules (see package.json), Apache-2.0 OR MIT" > "$dest/NOTICE"
    echo "vendor: helia bundled from node_modules"
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

# The three typefaces hud.css names (all OFL-1.1). They are @font-face'd from
# client/vendor/fonts, and every rule that uses them names a system fallback —
# a checkout that never ran this still reads, it just loses the condensed caps.
# @fontsource ships the woff2 files on npm, which is reachable where
# fonts.gstatic.com often is not.
vendor_font () {
    local pkg=$1 version=$2 face=$3 out=$4
    local dest=client/vendor/fonts tmp
    [ -f "$dest/$out" ] && [ "${FORCE:-}" != "1" ] && {
        echo "vendor: $dest/$out is already here (FORCE=1 to refetch)"; return 0; }
    mkdir -p "$dest"
    tmp=$(mktemp -d)
    ( cd "$tmp" && npm pack "@fontsource/${pkg}@${version}" --silent > /dev/null ) || {
        echo "vendor: @fontsource/${pkg} unreachable, skipping"; rm -rf "$tmp"; return 0; }
    tar xzf "$tmp"/fontsource-*.tgz -C "$tmp"
    if [ -f "$tmp/package/files/$face" ]; then
        cp "$tmp/package/files/$face" "$dest/$out"
        cp "$tmp/package/LICENSE" "$dest/LICENSE-${pkg}" 2>/dev/null || true
        echo "vendor: $pkg $version from npm"
    else
        echo "vendor: $pkg $version has no $face, skipping"
    fi
    rm -rf "$tmp"
}

vendor_fonts () {
    vendor_font rajdhani "$RAJDHANI_VERSION" \
        rajdhani-latin-600-normal.woff2 rajdhani-600.woff2
    vendor_font sora "$SORA_VERSION" \
        sora-latin-400-normal.woff2 sora.woff2
    vendor_font jetbrains-mono "$JETBRAINS_VERSION" \
        jetbrains-mono-latin-400-normal.woff2 jetbrains-mono.woff2
}

# three.js, three-mesh-bvh and three-gpu-pathtracer (all MIT): the frame
# atom's renderer (client/lib/raster.js and, for global illumination, client/lib/pathtrace.js). The ES-module builds import each
# other by bare specifier and a Web Worker has no import map, so the specifiers
# are rewritten to the flat layout under client/vendor/three/. `frame` imports
# these paths directly — this is not a CDN mirror, it is the copy that runs.
# litegraph.js (MIT): the canvas the Flows app draws a flow on. A classic
# script that attaches LiteGraph to window; client/flow/ reads it off there.
# Checked in like three and brush, because a checkout has to be able to open
# the app without a network — this only refreshes it.
vendor_litegraph () {
    local dest=client/vendor/litegraph
    local raw="https://raw.githubusercontent.com/jagenjo/litegraph.js/${LITEGRAPH_COMMIT}"
    [ -f "$dest/litegraph.js" ] && [ "${FORCE:-}" != "1" ] && {
        echo "vendor: $dest is already here (FORCE=1 to refetch)"; return 0; }
    mkdir -p "$dest"
    if curl -sSf -o "$dest/litegraph.js" "$raw/build/litegraph.js" \
        && curl -sSf -o "$dest/litegraph.css" "$raw/css/litegraph.css"; then
        echo "vendor: litegraph at ${LITEGRAPH_COMMIT:0:7} from $raw"
    else
        echo "vendor: $raw unreachable; the checked-in copy stays (client/vendor/litegraph/NOTICE)"
    fi
}

vendor_three () {
    local dest=client/vendor/three tmp
    [ -f "$dest/three-gpu-pathtracer.js" ] && [ "${FORCE:-}" != "1" ] && {
        echo "vendor: $dest is already here (FORCE=1 to refetch)"; return 0; }
    tmp=$(mktemp -d)
    ( cd "$tmp" && npm pack "three@${THREE_VERSION}" "three-mesh-bvh@${BVH_VERSION}" \
        "three-gpu-pathtracer@${PATHTRACER_VERSION}" --silent > /dev/null ) || {
        echo "vendor: three/three-mesh-bvh/three-gpu-pathtracer unreachable, skipping"
        rm -rf "$tmp"; return 0; }
    mkdir -p "$dest" "$tmp/three" "$tmp/bvh" "$tmp/pt"
    tar xzf "$tmp"/three-"${THREE_VERSION}".tgz -C "$tmp/three"
    tar xzf "$tmp"/three-mesh-bvh-*.tgz -C "$tmp/bvh"
    tar xzf "$tmp"/three-gpu-pathtracer-*.tgz -C "$tmp/pt"
    local t="$tmp/three/package" j="$tmp/three/package/examples/jsm"
    cp "$t/build/three.module.js" "$t/build/three.core.js" "$t/LICENSE" "$dest/"
    cp "$j/loaders/GLTFLoader.js" "$j/utils/BufferGeometryUtils.js" \
       "$j/utils/SkeletonUtils.js" "$j/postprocessing/Pass.js" "$dest/"
    cp "$tmp/bvh/package/build/index.module.js" "$dest/three-mesh-bvh.js"
    cp "$tmp/pt/package/build/index.module.js" "$dest/three-gpu-pathtracer.js"
    sed -i -e "s#from 'three'#from './three.module.js'#" \
           -e "s#from 'three-mesh-bvh'#from './three-mesh-bvh.js'#" \
           -e "s#from 'three/examples/jsm/postprocessing/Pass.js'#from './Pass.js'#" \
           -e "s#from '../utils/BufferGeometryUtils.js'#from './BufferGeometryUtils.js'#" \
           -e "s#from '../utils/SkeletonUtils.js'#from './SkeletonUtils.js'#" \
           "$dest"/*.js
    printf 'three %s, three-mesh-bvh %s, three-gpu-pathtracer %s — all MIT\n' \
        "$THREE_VERSION" "$BVH_VERSION" "$PATHTRACER_VERSION" > "$dest/NOTICE"
    rm -rf "$tmp"
    echo "vendor: three $THREE_VERSION + bvh $BVH_VERSION + pathtracer $PATHTRACER_VERSION from npm"
}

vendor_draco
vendor_ol
vendor_fonts
vendor_three
vendor_litegraph
vendor_helia

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
