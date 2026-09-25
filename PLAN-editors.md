# PLAN-editors — shaping ground, drawing lines, drawing areas

The three editors a player builds his land with. Written for `TASKS-editors.md`;
read `CLAUDE.md`, `docs/SPEC.md` §2.17 and `client/js/sculpt*.js` first. The
compiler, the symbols and the approval flow are not touched: these editors
write what already exists (a land's relative-metres grid, `feature` rows) and
only change how a person gets there.

## 0. Decisions

| # | Decision |
|---|---|
| D1 | Terrain (**Shape**) and lines (**Lines**) are two surfaces of the Build plinth. Areas (**Areas**) are drawn in the Survey view's map. |
| D2 | Shape and Lines share one ground view, **Blueprint**: the land as a white shaded mesh, no splats, no textures. It is a mode of the world view, not a page. |
| D3 | Lines never move the ground by themselves. Laying a bed is a separate, explicit step: select a line → Lay bed → the Along-line brush, pre-filled. |
| D4 | There is one line tool and one area tool. What is drawn is a **kind** picked from the operator's vocabulary (`highway`, `waterway`, `barrier`, `natural`, …, OSM-shaped). Kinds are data: the operator adds one in Settings → Vocabulary and gives it a Symbol; it appears in the picker. No code per kind. |
| D5 | A line or area stops at the land boundary. Its end becomes a snap point a neighbour can continue from. Drawing onto somebody else's land is refused with the same red the brush uses. (Proposals stay as they are; not surfaced here.) |
| D6 | The regular user gets: Raise/Lower, Smooth, Flatten, Level, Along line, Put back, one line tool, one area tool. Nothing else is a mode. Power lives in the settings box and in snapping, not in more tools. |
| D7 | Areas keep OpenLayers (vendored, works, snapping and modify for free). Lines are drawn in the PlayCanvas world with our own small spline code — no new dependency, and they must sit on the 3D ground. |
| D8 | Nothing reaches the world until Save, for all three. Save → tiles `changed` → Submit → approval, unchanged. |

Legacy: the `terrainmod` kind (polygons that moved ground) is not offered anywhere. Buildings are not drawn as areas; a house is placed from the catalog.

## 1. Ideas

Ground (Blueprint mode)
1. **White clay**: ground as a matte white mesh lit from the north-west, slope-tinted from white (flat) through grey to a warm tone above 35°. Contour lines every 2 m (fine) and 10 m (bold) drawn on the mesh, not as a layer.
2. **What you changed, as colour**: cells above the DEM blue, below red, alpha by metres. The land is white where you did nothing. Toggle. Also draws the *unsaved* part hatched, so saved and unsaved shaping are different at a glance.
3. **Everybody else dimmed**: outside your land the mesh is 60 % darker and locked; the boundary is a thin line that turns red when the brush touches it.
4. **Numbers at the cursor**: ground height, this stroke's delta, total off the DEM, slope under the brush. One small box that follows the pointer.
5. **Peek** (hold Tab): the splats and preview models fade in over the blueprint for as long as the key is held. Verify without leaving.
6. **Section line**: drag a line anywhere → a profile strip along the bottom (height, slope %). Same strip a line uses (§2.3).
7. **Earth moved**: the land card says "1 240 m³ raised · 880 m³ lowered". Cheap to compute from the grid, oddly satisfying, and reads as real.
8. **Ortho / perspective** toggle (O). Top-down orthographic is where precision happens; a 45° perspective is where you judge it.

Shape
9. **One brush, two directions**: Raise; Shift lowers. Hold to grow: the longer the pointer rests, the more it moves (the screenshot's behaviour). Strength is per second, not per dab, so it feels the same at every frame rate.
10. **Falloff curve with four presets** (smooth · linear · sharp · plateau) and a live curve drawing. Size in metres, shown as a circle on the ground that is visible before the first drag.
11. **Flatten with a fall**: Flatten makes a plane through the click point; the box offers a slope (0–5 %) and a direction arrow so a terrace drains. Default 0.
12. **Level to**: typed height, or Alt-click picks it off the ground, or "floor of …" lists placed things on this land. A level stroke shows the target plane as a translucent sheet while dragging.
13. **Edge blend**: strength fades to zero over the last 4 m before the boundary, so a neighbour never gets a cliff. Shown as a soft inner band. Can be turned off by the operator per world, never by the player.
14. **Strokes as history**: a list of strokes, newest first; click one to undo back to it; the undone ones stay struck through until a new stroke replaces them. Ctrl-Z/Ctrl-Shift-Z walk the same list.
15. **Put back** is a brush: erase your shaping under the pointer, back to the DEM. Also a button for the whole land, with a confirm.
16. **Limits stated where they bite**: the operator's max metres up/down (SPEC §6) is a line on the numbers box; the brush stops at it and the number turns amber, never silently clamps.

Lines
17. **Click to draw, drag to sketch**: click places corners; a held drag sketches freehand and is simplified on release (Douglas–Peucker, 0.5 m). Enter/double-click ends, Esc drops the last node.
18. **Smooth or sharp per node**: nodes are smooth (Catmull-Rom) by default; double-click a node makes it a corner. A road is smooth, a wall is corners — the kind sets the default.
19. **Snaps that matter, nothing else**: line ends (own and neighbours'), the land boundary, area edges, 15° angles while a modifier is held, and a 1 m grid when the grid is on. Each snap says what it hit in a two-word tag.
20. **Width handles**: drag a node sideways to change width there; the kind's default width is the starting value. The ribbon is drawn on the ground as a flat band so the width is seen before anything is compiled.
21. **Profile strip**: the selected line's height along its length, slope in %, segments over the kind's max gradient in red with a click-to-go marker. Reuses `client/lib/gen/check.js`.
22. **Follow contour**: while held, new nodes snap to the height of the first node — a path across a slope, an irrigation channel, a terrace edge without touching the ground.
23. **Lay bed** (one click on a selected line): opens the Along-line brush with this line, its width and the kind's shoulder pre-filled. Apply lays it once. That is the only place lines and ground meet.
24. **Extend, split, join, reverse** from the node context menu; drag a segment's middle to insert a node.
25. **Walk it** (F on a selected line): the camera drops to eye height at the nearest node and follows the line at walking speed; Esc returns to the blueprint camera where it was.
26. **Kind picker**: a searchable palette of what the operator defined for lines, each with the symbol's swatch and one-line "what it becomes". Recent kinds on top; keys 1–9 for the first nine. The same palette for areas, filtered to polygons.
27. **Ghosts**: neighbours' lines and areas drawn faint and unselectable, so a road can be continued straight and a forest edge met.

Areas
28. **One Draw tool**: click corners, or hold to sketch; closing snaps to the first point. Clipped to the land on finish, never refused for crossing the boundary.
29. **Paint an area**: a round brush that unions circles into one polygon (forest painted like a Manor Lords zone). Same result as Draw; friendlier for organic shapes.
30. **Same kind, one area**: two areas of the same kind that overlap are merged on Save; a different kind cuts a hole. The rule is shown once in the panel.
31. **The form is the vocabulary**: the fields shown are the kind's own properties, with the operator's defaults filled in. A field nobody compiles is not shown.
32. **What it becomes**: the area is filled with the symbol's colour and a name tag, so meadow and forest read differently before anything is rendered.

Later, not v1: stamps (a pond, a terrace, a hairpin from the catalog), mirror/array along a line, terracing tool, area brush erase, importing a GPX as a line.

## 2. Concept

### 2.1 Blueprint mode (shared by Shape and Lines)

Entered by opening Shape or Lines with a land chosen; left by closing the surface. While in it:

- The splats and preview models over every land in view are hidden (`tiles.js hideUnder`, as Shape does now). The ground is a mesh at the land's grid cell size (`r32` cell, 512²/tile) for the chosen land and a 1 km margin; beyond that the z14 ground mesh as today.
- Shading per D2/ideas 1–3, contours from the mesh, the "changed" colour from the grid values, hatching for unsaved cells.
- Camera: orbit around a point on the ground. Wheel zooms to the pointer, middle-drag or right-drag orbits, pitch limited 30°–90°, O toggles ortho. The player's walk camera is detached (as `sculptui` does) and restored on leave. "Zoom to land" on the land chooser.
- Tab peek (idea 5). Section line (idea 6) is a tool on the shared rail.
- Overlays box (one card, top-left under the tool rail): contours 2 m · changed as colour · grid 5 m · slopes above N° · neighbours' features. Each a switch. Remembered per player in localStorage.
- Numbers box at the cursor (idea 4).
- The mesh is rebuilt from the grid on every stroke for the dirty rectangle only; the whole land only on load, undo-to and put back.

### 2.2 Shape

Tools on the rail (glyphs, one in hand): Hand (H) · Raise/Lower (R, Shift inverts) · Smooth (S) · Flatten (G) · Level (L) · Along line (B) · Put back (X) · Section (C). Under the rail: Undo · Redo · Save · Put back land.

Settings box beside the rail shows only what the tool in hand reads:

| Tool | Reads |
|---|---|
| Raise/Lower | Size · Strength (m/s) · Falloff · curve preset · shape circle/square |
| Smooth | Size · Strength · Falloff |
| Flatten | Size · Strength · Falloff · fall % · fall direction (arrow on the ground, drag to turn) |
| Level | Size · Strength · Falloff · height (typed / Alt-pick / floor of…) |
| Along line | line (pick on ground or from the Lines list) · width · shoulder · max gradient · Apply |
| Put back | Size · Falloff |

Rules
- Strength is metres per second at the brush centre at full falloff; a dab is `strength × dt × falloff(d)`. Hold to grow follows from that.
- Outside the land the brush is red and changes nothing; over the boundary band strength is blended (idea 13).
- A stroke is pointer-down to pointer-up; one entry in the history; undo restores the grid cells it touched. Along line, Level and Put back land are strokes too.
- Limits (SPEC §6): max up/down from the DEM, shown and enforced per cell.
- Save writes one new `r32` (Invariant 1), then `height_edit`; the tiles under changed cells go `changed`. Leaving with unsaved strokes asks Save / Discard / Stay. If the file store or PostgREST is not answering, strokes are kept in OPFS (`client/lib/opfs.js`) and Retry is offered; nothing is lost on reload.

### 2.3 Lines

A line is a `feature` row (LineStringZ) whose `kind` is a line kind of the vocabulary and whose props are that kind's fields (`width` always). Stored geometry is the *smoothed, densified* polyline (1 m or one node per 5° of turn, whichever is finer) so QGIS, the compiler, movers and `check.js` see exactly what today's roads are. The control nodes and per-node smooth/corner flags are kept in `props.ctrl` so re-editing gives the handles back; a line edited in QGIS loses `ctrl` and is edited as corners.

Tools on the rail: Hand · Draw (D) · Select/Edit (V) · Section (C). Under the rail: Undo · Redo · Save.

Panel (the Lines surface): kind picker (idea 26); list of this land's lines (name · kind · length · slope max, red if over); the selected line's fields; buttons Lay bed · Walk it · Reverse · Delete.

Drawing (ideas 17–19, 22, 27): nodes are placed on the ground; height is the mesh's at that point. Ending on nothing ends the line; ending on another line's end joins if the kinds match, else snaps. A node dropped over the boundary snaps to the boundary; if it would cross more than one land it is refused with the red tag "not your land".

Editing (ideas 18, 20, 24): drag node · drag segment middle inserts · double-click toggles smooth/corner · Delete removes node (line with one node left is deleted) · context menu: Split here · Join with… · Extend. Width per node via a sideways handle; a plain line has one width in `props.width` and per-node widths only when a handle was moved (`props.widths`).

Profile strip (idea 21) opens for the selected line along the bottom; hover a point on the strip → marker on the ground and vice versa.

Lay bed (D3, idea 23) switches to Shape with Along line in hand and the line loaded. Nothing else in Lines touches the grid.

Save writes/updates/deletes `feature` rows through PostgREST as `edit.js` does now; the same RLS decides. Unsaved leave: Save / Discard / Stay.

### 2.4 Areas (Survey)

The Survey view's map is `editmap.js`/`editui.js` moved in and cut down:

- Basemap: the world's hillshade (WMS, as the map already uses) with land boundaries, own land lit, others dimmed. Lines drawn read-only with the symbol's colour; clicking one says "Edit in Build → Lines".
- Tools: Hand · Draw (click/sketch) · Paint (idea 29) · Edit (modify vertices, OL Modify with Snap) · Erase (delete area). One kind picker (idea 26, polygons only).
- Panel: the selected area's fields from the vocabulary; the merge/cut rule stated once (idea 30).
- On finish: clip to the land (OL `ol/geom` intersection is not in the bundle; do it with our `client/lib/poly.js` clip, Sutherland–Hodgman for the convex hull of the land and the ring for the rest — write it, no dep), union with same-kind neighbours, subtract from other-kind overlaps.
- Save: `feature` rows, as today. Tiles `changed`.

Areas are not in Blueprint mode; they show there as ghost outlines (idea 27) so a road can meet a forest edge.

### 2.5 Kinds (D4)

`Settings → Vocabulary` already defines what a thing may say; `Settings → Symbols` what it becomes and for which geometry (`symbolsui.js GEOMETRY`). The pickers read: every kind whose symbol geometry is `line` (Lines) or `polygon` (Areas), with the kind's fields, defaults, swatch and description. Two additions the operator gets: a per-kind default width, default smooth/corner, max gradient (used by the profile strip), and a `hidden` flag to keep a kind out of the pickers. A player-made kind is an operator adding a vocabulary entry and a symbol pointing at a player's product — no editor code.

### 2.6 How they interact

- One land, one grid, one feature table. Shape reads lines (Along line, ghosts); Lines reads the grid (heights, profile); Areas reads lines (ghosts). None writes the other's data except Lay bed, which is a Shape stroke.
- Submit lists ground, lines and areas of the land together, as it lists everything else; steep-road warnings come from the same `check.js` the profile strip uses.
- Undo is per surface and per session. Save clears it.
- Chrome: Build plinth becomes Place · Catalog · Land · Shape · Lines · Publish (1–6). Survey plinth: Parcels · Areas · Requests. Shape moves out of Land (it was Land → Shape).

## 3. UX rules for the build (instructions for Claude Code)

1. **Feel gates before feature gates.** Before any new tool: a raise stroke updates the mesh within one frame at 60 fps on a 4 km² land on an integrated GPU; the brush circle is visible at rest; nothing is more than two clicks from the rail. Measure in `client/test/` with a scripted stroke and assert frame time.
2. **Design first, per surface.** Each phase starts by drawing the surface as an artboard in `docs/design/` (chrome as v6/v8) and a screenshot next to it once built. No panel is built that is not on an artboard.
3. **Words on the ground, not in the manual.** Every state a tool has says so in a two-word tag at the pointer (`not your land`, `snapped: road end`, `over limit`). The panel's notes explain once; the tag explains every time.
4. **Nothing is a mode you have to leave.** Pan is a tool; peek is a held key; the profile strip is a drawer. The player never turns shaping off to look.
5. **Keys are printed where they act** (rail glyphs carry their key; the settings box its shortcuts), and are the same across Shape, Lines, Areas where the action is the same (H, V, Ctrl-Z, Esc, Enter).
6. **Reuse, then delete.** `sculpt*.js`, `edit.js`, `editmap.js`, `poly.js`, `check.js`, `route.js` are the base. Move Shape out of Land; retire the `terrainmod` kind from `KINDS`; delete `oldshapes.js` once no world has shapes left (db says). Ask before removing anything else.
7. **One story = one commit** with a player-run script; a story opens the surface, does the thing with the pointer, saves, and checks rows or the grid. Phase order below; no phase starts before the previous is green.
8. **No dependency.** Spline math, clipping, union, simplify are written in `client/lib/` with node tests. OpenLayers stays vendored for Areas only.
9. **Say what happened after Save**: "ground saved · 3 tiles changed", "2 lines saved", "forest saved · merged with 1". Same words in the notification tray.
10. **Phases**: A Blueprint mode (§2.1) → B Shape rebuilt on it (§2.2) → C Lines (§2.3) → D Areas in Survey (§2.4) → E kinds and pickers (§2.5) → F polish gates (feel, tags, artboard screenshots, manual). Each phase ends with a session where Tobias uses it for ten minutes and lists what was wrong; that list becomes the first tasks of the next phase.
