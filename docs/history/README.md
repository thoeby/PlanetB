# docs/history — finished plans and task files

Kept because commit messages, code comments and `PROGRESS.md` cite them
(`TASKS-usable T8`, `REFACTOR-direct-pg.md S2`, `WP3.1`). Nothing here is a
task any more; where one of them disagrees with the code or with
`ARCHITECTURE.md`, the code wins.

| file | what it was | state |
|---|---|---|
| `TASKS.md` | WP0–WP5, the first build: schema, API, files, atoms, pool, Switzerland, ops | done (`PROGRESS.md`) |
| `TASKS-usable.md` | T0–T9, "make splatworld usable": one world on one DEM, land drawn in QGIS | done, then replaced by `PLAYER-RUN.md` |
| `REFACTOR-direct-pg.md` | S1–S7: QGIS edits Postgres directly as the player; GeoServer serves rasters only | done (`db/0065_playerroles.sql`, `server/splatworld/qgis.py`) |
| `PLAN-lod.md` | detail inside a tile: a tile's splats as levels for PlayCanvas's octree LOD | done (`db/0134`, `db/0137`, `client/lib/lodorder.js`) |

The original brief (CLAUDE.md, ARCHITECTURE.md and TASKS.md as first handed
over, 2026-09-08) is in git history under `docs/brief/`.
