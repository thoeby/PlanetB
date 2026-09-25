# TASKS-editors — Shape, Lines, Areas

Implements `PLAN-editors.md`. Rules of `CLAUDE.md` apply: one story = one
commit `EDT.x: <title>`, `make gate` green, player-run script per story, no
dependency, files < 400 lines, ask before touching a migrated table or an RPC
signature. Start each phase by drawing its artboard in `docs/design/`
(`splatworld-v11.dc.html`, chrome from v8) and get it approved before code.

## Phase A — Blueprint mode

**EDT.1 Blueprint ground mesh.** `client/js/blueprint.js` (+ `blueprint.css`).
Given a land: build a mesh at the land's `r32` cell size over the land bbox
plus 1 km, DEM + grid, white slope-tinted vertex colours, north-west light;
z14 ground mesh beyond. Hides splats/previews under it (`tiles.js hideUnder`).
`rebuild(rect)` for a dirty rectangle only. Gate: node test on colour/slope
mapping; playwright: 4 km² land opens < 1.5 s, one `rebuild` of 64² cells
< 8 ms.

**EDT.2 Contours and changed-as-colour.** Contour lines 2 m / 10 m from the
mesh (marching squares on the height grid, drawn as line entities). Grid cell
delta → blue/red overlay; unsaved cells hatched. Overlays card with switches
(contours · changed · grid 5 m · slopes > N° · neighbours), state in
localStorage. Gate: node test contours on a synthetic cone; screenshot.

**EDT.3 Blueprint camera.** Orbit camera: wheel zoom to pointer, middle/right
drag orbit, pitch 30–90°, O toggles ortho, Zoom-to-land. Detach/restore the
walk camera as `sculptui` does. Gate: playwright drives keys and asserts
camera state; walk camera restored on leave.

**EDT.4 Cursor numbers, tags and peek.** Numbers box at the pointer (ground,
this stroke, off the DEM, slope). Two-word state tags (`client/js/groundtag.js`).
Hold Tab: splats/previews fade in over the mesh, out on release. Gate:
playwright asserts tag text on boundary hover and peek visibility.

**EDT.5 Section tool.** Drag a line → profile strip drawer along the bottom
(height, slope %), hover sync both ways. `client/js/profilestrip.js`, reused
by EDT.14. Gate: node test for sampling along a line; screenshot.

## Phase B — Shape on Blueprint

**EDT.6 Shape as a Build surface.** Move Land → Shape to plinth `Shape`
(key 4); Build plinth = Place · Catalog · Land · Shape · Lines · Publish.
Opening Shape enters Blueprint (EDT.1–5). Gate: player-run story
"open Shape, see white land, walk camera restored on close".

**EDT.7 Brush model rewrite.** `sculptbrush.js`: strength as m/s, dab =
strength × dt × falloff(d); falloff curve with presets smooth/linear/sharp/
plateau, curve drawn live; shape circle/square; Shift inverts Raise. Brush
circle visible at rest. Boundary band blend (4 m, operator switch
`world.edge_blend`). Gate: node tests on dab arithmetic and band; playwright
stroke → mesh updates same frame.

**EDT.8 Flatten with fall, Level to.** Flatten: plane through click point,
fall % + direction arrow on the ground. Level: typed / Alt-pick / floor of a
placed thing; target plane drawn while dragging. Gate: node tests (plane
fit, fall direction); player-run "level a pad to the house floor".

**EDT.9 Strokes history and Put back.** History list newest first, click to
undo back to, struck-through redo; Ctrl-Z/Ctrl-Shift-Z. Put back brush (X)
and Put back land (confirm). Gate: node test on the stroke stack; player-run
undo-to restores cells exactly.

**EDT.10 Limits and save resilience.** Per-cell max up/down from SPEC §6 shown
on the numbers box, brush stops and goes amber. Save → new r32 + height_edit,
"ground saved · N tiles changed". Failure keeps strokes in OPFS and shows
Retry; reload restores them. Gate: api-test with PostgREST stopped mid-save;
player-run reload-after-failure.

**EDT.11 Earth moved.** Land card: m³ raised / lowered from the grid. Gate:
node test on a known grid.

## Phase C — Lines

**EDT.12 Spline lib.** `client/lib/spline.js`: Catmull-Rom through nodes with
per-node corner flag, densify (1 m or 5°), Douglas–Peucker simplify (0.5 m),
length, nearest point, split/join. Pure, node-tested.

**EDT.13 Lines surface and Draw.** Plinth `Lines` (key 5), enters Blueprint.
Kind picker from vocabulary (line kinds, swatch, description, recent, 1–9).
Draw tool: click nodes, hold-drag sketch → simplify, Enter/double-click end,
Esc drops last. Nodes on the mesh height. Ribbon of the kind's width drawn
flat on the ground. Gate: player-run "draw a road of 6 nodes, save, row
exists as densified LineStringZ with props.ctrl".

**EDT.14 Snapping.** Own/neighbour line ends, land boundary, area edges, 15°
with Ctrl, 1 m grid when grid on; tag says what it hit. Boundary rule of
PLAN D5 (snap to boundary, refuse crossing into another land). Gate: node
tests per snap; playwright asserts tag text.

**EDT.15 Edit.** Select tool: drag node, drag segment inserts, double-click
toggles smooth/corner, Delete, context menu Split/Join/Extend/Reverse,
sideways width handle → `props.widths`. Undo/redo as EDT.9's stack. Gate:
player-run edit story; node test that ctrl → geometry round-trips.

**EDT.16 Profile strip and Walk it.** Selected line → strip (EDT.5) with
slope %, red over the kind's max gradient, click-to-go markers, reuses
`gen/check.js`. F: walk camera along the line, Esc back. Gate: node test on
red segments for a synthetic line; playwright walk-it restores camera.

**EDT.17 Follow contour and Lay bed.** Held key keeps new nodes at the first
node's height. Lay bed on a selected line → Shape, Along line loaded (line,
width, shoulder, max gradient), Apply lays one stroke. Gate: player-run "lay
a bed, undo it, lay again, save".

**EDT.18 Lines panel and ghosts.** List of this land's lines (name, kind,
length, slope max), fields of the selected line from the vocabulary,
neighbours' lines/areas as faint unselectable ghosts. Gate: screenshot;
player-run rename + delete.

## Phase D — Areas in Survey

**EDT.19 Survey map = editmap.** Survey plinth Parcels · Areas · Requests;
Areas opens `editmap.js` inside the page (not `edit.html`): hillshade WMS,
lands, own land lit, lines read-only with "Edit in Build → Lines". Gate:
player-run opens Survey → Areas.

**EDT.20 Draw and Paint.** One kind picker (polygon kinds). Draw (click /
sketch, close snaps to first). Paint: round brush unions circles
(`client/lib/polyops.js`: union, difference, clip — node-tested). Clip to
land on finish. Gate: node tests on polyops; player-run "paint a forest that
crosses the boundary, saved polygon is inside the land".

**EDT.21 Merge/cut on Save and the form.** Same kind overlapping → union;
other kind → hole. Panel: vocabulary fields with defaults, the rule stated
once. Save says "forest saved · merged with 1". Remove `terrainmod` and
`building` from the picker (`edit.js KINDS`). Gate: pgTAP untouched; node
test on merge; player-run.

**EDT.22 Edit and Erase.** OL Modify + Snap on own areas, Erase tool, undo.
Gate: player-run modify a vertex, save, row updated.

## Phase E — Kinds

**EDT.23 Kind defaults.** Vocabulary/Symbols gain per kind: default width,
default smooth/corner, max gradient, `hidden`. Pickers read them. Ask before
the migration (touches `vocabulary`/`build_symbol`). Gate: pgTAP for the new
columns; player-run "operator adds a `hedge` kind, it appears in Lines".

**EDT.24 Retire oldshapes.** When `select count(*) from feature where
kind='terrainmod'` is 0 in the seed and test worlds, delete `oldshapes.js`
and its test. Ask first.

## Phase F — Polish gates

**EDT.25 Feel gate.** `client/test/feel.test.js`: scripted 3-second raise
stroke on a 4 km² land, asserts p95 frame < 16.7 ms and mesh delta per
frame; scripted 40-node line draw, asserts < 4 ms per node. Runs in
`make client-test` (skipped without GPU, must run locally).

**EDT.26 Tags and words audit.** Every tool state has its tag; every Save its
sentence; keys printed on rail and box; `docs/manual.md` section per
surface, screenshots next to artboards. Gate: checklist in the PR body,
each item a screenshot.

**EDT.27 Ten-minute session.** Tobias uses Shape, Lines, Areas for ten
minutes each; his list becomes EDT.28+ and the first tasks of the next
round. Not a code task; do not skip it.
