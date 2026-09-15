#!/usr/bin/env bash
# Builds brush's JS/WebAssembly bindings (Apache-2.0) into client/vendor/brush.
# Needs Rust (stable, 1.95 or newer), the wasm32-unknown-unknown target and
# wasm-pack. The output is checked in; run this to bump the pinned commit.
set -euo pipefail

BRUSH_REPO=${BRUSH_REPO:-https://github.com/ArthurBrussee/brush}
BRUSH_REV=${BRUSH_REV:-main}
DEST=client/vendor/brush
WORK=$(mktemp -d)

rustup target add wasm32-unknown-unknown
command -v wasm-pack > /dev/null || cargo install wasm-pack --locked
git clone --depth 1 --branch "$BRUSH_REV" "$BRUSH_REPO" "$WORK/brush"
( cd "$WORK/brush/apps/brush-js" && wasm-pack build . --release --target web \
    --out-dir "$WORK/pkg" )
mkdir -p "$DEST"
cp "$WORK/pkg/brush_js.js" "$WORK/pkg/brush_js_bg.wasm" "$WORK/pkg/brush_js.d.ts" "$DEST/"
cp "$WORK/brush/LICENSE" "$DEST/LICENSE"
( cd "$WORK/brush" && git rev-parse HEAD ) > "$DEST/COMMIT"
echo "brush ($(cat "$DEST/COMMIT")), Apache-2.0, $BRUSH_REPO" > "$DEST/NOTICE"
rm -rf "$WORK"
echo "vendor: brush $(cat "$DEST/COMMIT") -> $DEST"
