Vendored third-party code. Checked in verbatim with its licence, because these
files are what runs and a checkout must work without `make vendor`:

- `three/` — three.js, three-mesh-bvh and three-gpu-pathtracer (all MIT), the
  frame atom's renderers (`client/lib/raster.js`, `client/lib/pathtrace.js`).
  Fetched by `tools/vendor.sh` from npm with bare specifiers rewritten, because
  a Web Worker has no import map; `tools/vendor.sh` is how a version is bumped.
- `brush/` — brush (Apache-2.0, github.com/ArthurBrussee/brush), the
  gaussian-splat trainer, as WebAssembly on WebGPU: `apps/brush-js` built by
  `tools/build-brush.sh` with `wasm-pack --target web`, at the commit in
  `brush/COMMIT`. Checked in, because a Rust toolchain is not something
  `make vendor` can assume. `client/lib/brush.js` is the seam.
- `litegraph/` — litegraph.js (MIT), the flow editor's canvas, pinned to one
  upstream commit (`litegraph/NOTICE`). `tools/vendor.sh` refetches it and
  keeps the checked-in copy where upstream cannot be reached.

Fetched by `make vendor` (`tools/vendor.sh`) rather than committed, because
they are builds rather than sources — the pinned versions are in that script:

- `playcanvas/` — the engine `play.html` loads from a CDN, MIT
- `draco/` — Google's mesh codec, for compressed GLBs (WP4.1), Apache-2.0
- `ol/` — OpenLayers, the map `edit.html` draws on (WP5.3), BSD-2-Clause
- `fonts/` — the page's web fonts

Nothing here is fetched at runtime by the tests; `client/` must stay servable
as static files.
