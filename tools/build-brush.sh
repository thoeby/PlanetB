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
# One change of ours (tools/brush-autotune.patch): autotune at the Full level,
# because burn's roofline throughput measurement reads synchronously and
# panics on wasm. Applied by hand rather than `patch`, so the hunk survives
# line drift; if the anchor is gone, look at what brush does now.
python3 - "$WORK/brush/apps/brush-js/src/lib.rs" <<'PY'
import sys, re
p = sys.argv[1]; s = open(p).read()
hunk = open('tools/brush-autotune.patch').read().split('@@\n', 1)[1]
add = ''.join(l[1:] for l in hunk.splitlines(True) if l.startswith('+'))
anchor = '        console_error_panic_hook::set_once();\n'
assert anchor in s, 'brush-js lib.rs: anchor for the autotune patch is gone'
open(p, 'w').write(s.replace(anchor, anchor + add, 1))
PY
( cd "$WORK/brush/apps/brush-js" && wasm-pack build . --release --target web \
    --out-dir "$WORK/pkg" )
mkdir -p "$DEST"
cp "$WORK/pkg/brush_js.js" "$WORK/pkg/brush_js_bg.wasm" "$WORK/pkg/brush_js.d.ts" "$DEST/"
cp "$WORK/brush/LICENSE" "$DEST/LICENSE"
( cd "$WORK/brush" && git rev-parse HEAD ) > "$DEST/COMMIT"
echo "brush ($(cat "$DEST/COMMIT")), Apache-2.0, $BRUSH_REPO" > "$DEST/NOTICE"
rm -rf "$WORK"
echo "vendor: brush $(cat "$DEST/COMMIT") -> $DEST"
