#!/usr/bin/env bash
# Builds brush's JS/WebAssembly bindings (Apache-2.0) into client/vendor/brush.
# Needs Rust (stable, 1.95 or newer), the wasm32-unknown-unknown target and
# wasm-pack. The output is checked in; run this to bump the pinned commit.
set -euo pipefail

BRUSH_REPO=${BRUSH_REPO:-https://github.com/ArthurBrussee/brush}
# Which CubeCL autotune level the build bakes in: Minimal, Balanced, Extensive
# or Full. Full is ours because the levels below it register burn's roofline
# bounds generator, whose throughput measurement reads a tensor synchronously
# and panics on wasm. Every level benchmarks its candidates, though, and the
# benchmarking is itself where this runtime has fallen over on a Pascal card
# ("Failed to map buffer: BufferAsyncError", cubecl-wgpu timings.rs): if a run
# dies there, build with AUTOTUNE_LEVEL=Balanced and see which failure you get,
# because the two are different bugs and only one of them is ours to dodge.
# `none` leaves brush's own defaults alone — no patch at all. Tried against
# ee797e9: the first mean panics on wasm ("Failed to read tensor data
# synchronously", cubecl-environment future/reader.rs), the roofline
# measurement the patch exists for. The web demo that runs without it is an
# older brush. The 800 ms a step this build was blamed for was the pump in
# client/lib/brush.js, not the level.
AUTOTUNE_LEVEL=${AUTOTUNE_LEVEL:-Full}
BRUSH_REV=${BRUSH_REV:-ee797e9edb5a9d4a5636981ffe965a941dd8df05}
DEST=client/vendor/brush
WORK=$(mktemp -d)

rustup target add wasm32-unknown-unknown
command -v wasm-pack > /dev/null || cargo install wasm-pack --locked
git clone -q "$BRUSH_REPO" "$WORK/brush" && ( cd "$WORK/brush" && git checkout -q "$BRUSH_REV" )
# One change of ours (tools/brush-autotune.patch): autotune at $AUTOTUNE_LEVEL,
# because burn's roofline throughput measurement reads synchronously and
# panics on wasm. Applied by hand rather than `patch`, so the hunk survives
# line drift; if the anchor is gone, look at what brush does now.
echo "brush: autotune level $AUTOTUNE_LEVEL"
[ "$AUTOTUNE_LEVEL" = none ] || python3 - "$WORK/brush/apps/brush-js/src/lib.rs" "$AUTOTUNE_LEVEL" <<'PY'
import sys, re
p = sys.argv[1]; s = open(p).read()
level = sys.argv[2]
assert level in ('Minimal', 'Balanced', 'Extensive', 'Full'), f'no such autotune level: {level}'
hunk = open('tools/brush-autotune.patch').read().split('@@\n', 1)[1]
add = ''.join(l[1:] for l in hunk.splitlines(True) if l.startswith('+'))
add = add.replace('__SPLATWORLD_AUTOTUNE_LEVEL__', level)
anchor = '        console_error_panic_hook::set_once();\n'
assert anchor in s, 'brush-js lib.rs: anchor for the autotune patch is gone'
open(p, 'w').write(s.replace(anchor, anchor + add, 1))
PY
# Two changes of ours, always (tools/brush-readback.patch): BrushSplats.read(),
# the splats off the GPU as typed arrays through burn itself, so the trainer
# can let brush make its own device (app.init(), the way brush's own app
# does) and still get the result back.
python3 - "$WORK/brush/apps/brush-js/src/lib.rs" <<'PY'
import sys
p = sys.argv[1]; s = open(p).read()
hunk = open('tools/brush-readback.patch').read().split('@@\n', 1)[1]
add = ''.join(l[1:] for l in hunk.splitlines(True) if l.startswith('+'))
anchor = '    pub fn buffers(&self) -> Option<BrushSplatBuffers> {\n'
assert anchor in s, 'brush-js lib.rs: anchor for the readback patch is gone'
open(p, 'w').write(s.replace(anchor, add + anchor, 1))
PY

# wasm-pack fetches binaryen's wasm-opt from GitHub releases at build time;
# where that download cannot be had (a sandbox behind a proxy), WASM_OPT=0
# packages without it and the module is optimised below with the binaryen
# npm ships instead — the same wasm-opt, the same flags brush's own release
# profile uses (apps/brush-js/Cargo.toml). Unoptimised it is 51 MB and
# slower on the CPU side; optimised, 18.
OPT=; [ "${WASM_OPT:-1}" = 0 ] && OPT=--no-opt
( cd "$WORK/brush/apps/brush-js" && wasm-pack build . --release --target web $OPT \
    --out-dir "$WORK/pkg" )
if [ -n "$OPT" ]; then
    ( cd "$WORK" && npm init -y > /dev/null && npm install --no-audit --no-fund binaryen > /dev/null )
    "$WORK/node_modules/binaryen/bin/wasm-opt" -Oz --converge \
        --enable-bulk-memory --enable-nontrapping-float-to-int --enable-simd \
        --enable-reference-types --enable-multivalue --enable-sign-ext \
        --enable-mutable-globals --enable-bulk-memory-opt --enable-call-indirect-overlong \
        "$WORK/pkg/brush_js_bg.wasm" -o "$WORK/pkg/brush_js_bg.opt.wasm"
    mv "$WORK/pkg/brush_js_bg.opt.wasm" "$WORK/pkg/brush_js_bg.wasm"
fi
mkdir -p "$DEST"
cp "$WORK/pkg/brush_js.js" "$WORK/pkg/brush_js_bg.wasm" "$WORK/pkg/brush_js.d.ts" "$DEST/"
cp "$WORK/brush/LICENSE" "$DEST/LICENSE"
( cd "$WORK/brush" && git rev-parse HEAD ) > "$DEST/COMMIT"
echo "brush ($(cat "$DEST/COMMIT")), Apache-2.0, $BRUSH_REPO" > "$DEST/NOTICE"
rm -rf "$WORK"
echo "vendor: brush $(cat "$DEST/COMMIT") -> $DEST"
