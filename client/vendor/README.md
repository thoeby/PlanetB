Vendored third-party code, checked in verbatim with its licence:

- `splatjs/` — training kernel (WP3.1), MIT
- `splat-transform/` — `.sog` encoder core (WP2.6)
- `three/` — three.js, three-mesh-bvh and three-gpu-pathtracer (MIT), the
  frame atom's path tracer (`client/lib/pathtrace.js`). Fetched by
  `tools/vendor.sh` from npm with bare specifiers rewritten, because a Web
  Worker has no import map. Unlike the engine there is no CDN copy: these
  files are what runs, so they are checked in (the one vendored directory
  that is), and `tools/vendor.sh` is how a version is bumped., MIT

Fetched by `make vendor` (`tools/vendor.sh`) rather than committed, because
they are builds rather than sources — the pinned versions are in that script:

- `playcanvas/` — the engine `play.html` loads from a CDN, MIT
- `draco/` — Google's mesh codec, for compressed GLBs (WP4.1), Apache-2.0
- `ol/` — OpenLayers, the map `edit.html` draws on (WP5.3), BSD-2-Clause

Nothing here is fetched at runtime by the tests; `client/` must stay servable
as static files.
- `brush/` — brush (Apache-2.0, github.com/ArthurBrussee/brush), the
  gaussian-splat trainer, as WebAssembly on WebGPU: `apps/brush-js` built by
  `tools/build-brush.sh` with `wasm-pack --target web`. Checked in, because a
  Rust toolchain is not something `make vendor` can assume. `client/lib/brush.js`
  is the seam.
