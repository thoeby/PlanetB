Third-party code the client loads, copied here so the browser tests run without
a network. Everything in this directory except this file is gitignored;
`make vendor` (`tools/vendor.sh`) fetches it and pins the versions.

- `playcanvas/` — PlayCanvas engine 2.22.0 (MIT). `play.html` loads the same
  build from the CDN at runtime; the playwright fixture routes that URL here.
- `splatjs/` — training kernel, WP3.1. Not vendored yet.

The client itself has no npm dependencies and must stay servable as static files.
