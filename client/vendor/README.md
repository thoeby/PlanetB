Vendored third-party code, checked in verbatim with its licence:

- `splatjs/` — training kernel (WP3.1), MIT
- `splat-transform/` — `.sog` encoder core (WP2.6), MIT

Fetched by `make vendor` (`tools/vendor.sh`) rather than committed, because
they are builds rather than sources — the pinned versions are in that script:

- `playcanvas/` — the engine `play.html` loads from a CDN, MIT
- `draco/` — Google's mesh codec, for compressed GLBs (WP4.1), Apache-2.0
- `ol/` — OpenLayers, the map `edit.html` draws on (WP5.3), BSD-2-Clause

Nothing here is fetched at runtime by the tests; `client/` must stay servable
as static files.
