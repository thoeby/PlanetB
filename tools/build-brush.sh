#!/usr/bin/env bash
# Builds brush's JS/WebAssembly bindings (Apache-2.0) into client/vendor/brush.
# Needs Rust (stable, 1.95 or newer), the wasm32-unknown-unknown target and
# wasm-pack. The output is checked in; run this to bump the pinned commit.
set -euo pipefail

BRUSH_REPO=${BRUSH_REPO:-https://github.com/ArthurBrussee/brush}
# Which brush. 48ca31c (2026-05-03) is the first commit with brush-js, one
# week after e700993, the revision brush's own web demo was deployed from
# (github.com/ArthurBrussee/brush-demo, 2026-04-25): the same burn/CubeCL
# generation, with brush's own wasm settings (one CubeCL stream, default
# autotune) and none of ours needed. Every revision tried before it (5ee2053,
# ee797e9) is after brush moved onto burn's new runtimes (ce76c88, #526) and
# before anyone ran that on the web: autotune panicked, fills did not land,
# subgroup kernels lacked their directive, and a step took thirty times the
# demo's on the same card with the same dataset.
BRUSH_REV=${BRUSH_REV:-48ca31c28b74d85bbd938f03e53cb66c7b94789a}
# Which CubeCL autotune level to bake in (tools/brush-autotune.patch):
# Minimal, Balanced, Extensive, Full, or `none` for brush's own default. The
# patch exists for ee797e9 and later, whose roofline measurement reads a
# tensor synchronously and panics on wasm; at 48ca31c it has no anchor.
AUTOTUNE_LEVEL=${AUTOTUNE_LEVEL:-none}
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

# The third change (tools/brush-counters.patch): the render pass's two atomic
# counters are zeroed by a host write, not by int_zeros, whose one-element
# fill did not land on wasm — the counts accumulated step over step, panicked
# on a tile every camera sees whole ("num_visible > total_splats"), and sized
# every sort and raster pass wrong on every other tile.
python3 - "$WORK/brush/crates/brush-render/src/render.rs" <<'PY'
import sys
p = sys.argv[1]; s = open(p).read()
hunk = open('tools/brush-counters.patch').read().split('@@\n', 1)[1]
old = ''.join(l[1:] for l in hunk.splitlines(True) if l.startswith('-'))
new = ''.join(l[1:] for l in hunk.splitlines(True) if l.startswith('+'))
if old in s:
    open(p, 'w').write(s.replace(old, new, 1))
else:
    # Revisions before ee797e9 name the counters differently and zero them
    # on a stack where the fill lands; the patch is for the later ones.
    assert 'num_visible_buf =' not in s, 'brush-render render.rs: the counters moved'
    print('brush: render counters left as brush has them')
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
