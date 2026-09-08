#!/usr/bin/env bash
# Fetches the third-party code client/ loads from a CDN into client/vendor/, so
# the browser tests can run without network access. The vendored copies are
# gitignored: this script, and the pinned versions in it, are the record.
#
# Nothing here changes what a browser loads in production — play.html still
# points at the CDN. The playwright fixture routes that URL to the local copy.
set -euo pipefail

PLAYCANVAS_VERSION=${PLAYCANVAS_VERSION:-2.22.0}
DEST=client/vendor/playcanvas

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
