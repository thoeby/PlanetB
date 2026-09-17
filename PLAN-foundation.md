# PLAN-foundation.md — assets, infrastructure, terrain, land cover, live objects, flows

Extends `docs/SPEC.md`. Worked like `PLAYER-RUN.md`: one story = one commit,
a story starts only when its predecessor is green, every story is proven by a
script that behaves like a player. Where this plan changes a table, an RPC or
an invariant, this plan is the approval (CLAUDE.md "ask before") — nothing
beyond what is written here.

---

## 0. Decisions (made by the owner)

| # | decision |
|---|---|
| D1 | Three object classes: **baked** (in the splat: terrain, roads, walls, trees, buildings), **live** (body baked, a live part drawn over the splat: lamp light, sign screen, door, barrier), **dynamic** (never baked, drawn and moved by the client: cars, trains, cable cars). |
| D2 | Dynamic v1 = **route movers**: route + schedule; every browser computes the position from the world clock. No per-frame networking. Player-driven vehicles need a realtime relay — not in this plan. |
| D3 | Catalog product types: `model`, `segment` (repeated along a line), `profile` (road cross-section), `collection` (weighted variants), `material` (terrain swatch). A model may declare **live parts**, **ports** (`on`, `image`, `open`…) and a **terrain opening** (tunnel portal). Buildings are user GLBs. |
| D4 | **Symbols** (QGIS-like): a rule = filter + a stack of generator layers. Authored by admins; landowners choose through properties. Versioned; a change reaches published tiles only when an admin presses "apply to world". |
| D5 | Terrain is shaped **only** by a painted height layer per land (relative metres over the DEM), painted in QGIS **and** in a sculpt tool in the page. Roads lie on whatever ground is painted; a "flatten along line" brush writes pixels once; a road over ground too steep across its width is flagged, never fixed silently. Existing terrain-edit shapes are converted into painted heights once, then the shape kind is retired. |
| D6 | Tunnels, bridges, caves, overhangs are products (objects), not terrain. A tunnel portal cuts an opening in the terrain mesh. |
| D7 | **Vocabulary = OSM tags.** Kinds and properties are seeded from OSM keys and values (§5), so OSM data can be loaded for testing unchanged. Where swisstopo is richer, its classes are mapped onto that vocabulary. Admins can add and change everything later. |
| D8 | Land cover: **natural cover only** from outside sources (OSM, swisstopo, WorldCover, CORINE) as GeoServer layers, mapped by admins onto the vocabulary. No biome system: the data is the biome. Hard borders are blended at compile time. Albedo + cover map are render outputs, shown as a layer in the page map and in QGIS. |
| D9 | A player edits only land he owns or holds a build grant on. When land is assigned, the source cover inside it becomes that land's own shapes. What gets rendered is approved by whoever holds the approve right (existing grants); players organise authority themselves. |
| D10 | **Flows are ELX.** The flow editor writes exactly the ELX the process server reads — same XML, same round-trip rules as the wireon process editor, which is a reference only (code may be copied; it is not a dependency). World features in the editor must end up as valid ELX. |
| D11 | **UI first.** The flow editor is built and usable now (draw, edit, save flows into the world, validate). Running flows (runner pool, pay, leases) follows later. |
| D12 | Runner pool (later): anyone runs a process server and takes others' flows, price per hour, 0 by default. **A flow never resumes** — a dropped run restarts fresh on the next runner; only world data persists; the owner sees every restart. The process server talks to the world by pull over REST; the world sends nothing out. |
| D13 | One baked light; lamps at night are a glow overlay. Ad-sign content changes go through approval like building. |

## 1. Amendments to ARCHITECTURE.md / CLAUDE.md

- **Invariant 9**, add: *Outside participants — QGIS, process servers — act as
  players with logins of their own, under RLS. The server decides and
  computes nothing, and sends nothing out.*
- **§9 Not in v1**: realtime multiplayer stays out; route movers are in.
- **Invariant 2**: a tile's snapshot pins the **symbol version** and
  **cover-mapping version** it was built with, instead of one digest over the
  whole rule table.
- **Artifact kinds** add: `height_edit`, `cover`, `flow`.
- **CLAUDE.md layout** adds `client/flow/` (the flow editor) and
  `client/vendor/litegraph.*`; the 400-line file rule applies to copied code
  too (split on copy).
- **SPEC**: menu adds Flows; Admin adds Symbols and Ground cover; §9.5 reads
  "approval by whoever holds the approve right on the land".

## 2. Data (migrations, in order)

| table / change | content |
|---|---|
| `kind`, `property` seed | OSM-based (§5). Existing kinds renamed: `road`→`highway`, `footprint`→`building`, `forest`→`landuse` (value `forest`), `water`→`natural` (value `water`), `tree`→`natural_point` (value `tree`). Rows follow via ON UPDATE CASCADE; props gain the OSM key. |
| `asset` + `type`, `parts` | type ∈ D3; `parts`: live parts (node → role light/screen/door/rotor), ports (name, type, default), terrain openings. Existing products stay `model`, canon-v1, same SAN. |
| `canon-v2` | keeps nodes tagged as parts separate and named; otherwise canon-v1. New uploads only. |
| `collection_item` | collection SAN, member SAN, weight. |
| `symbol` | kind, name, version, ordering, filter (as `build_rule`), `layers` jsonb (§3), enabled. `build_rule` rows migrate to one-layer symbols; `build_rule` dropped after the migration test proves identical output. |
| `style_version` | "apply to world": which symbol and cover-mapping versions new jobs pin; affected tiles marked stale at low priority. |
| `height_edit` | land, artifact sha256 (relative metres, float32, finest render grid), rev. Immutable; a save is a new row; trigger marks tiles changed; clamped to the land. |
| `ground_layer.kind` + `cover` | source layer (vector or raster), extent, priority, `class_map` (source value → OSM tags), `mapping_version`. |
| `feature` kinds from cover | the land's own cover shapes (D9), same kinds as drawn ones. |
| `live_state` | instance, port, value, rev, written_by, at. |
| `mover` | land, product SAN, route (feature or own line), speed, schedule, phase, rev. |
| `world_event` | outbox: id, at, land, instance, type (enter, leave, click, port_changed), payload. Pruned after 24 h. |
| `flow` | land, owner, name, ELX artifact (sha256), bindings, rev. Runner fields (price, allowed runners, state) added in F10. |
| `elx_plugin` | plugin id, plugin XML artifact, source (bundled / reported by a runner), seen_at. Feeds the palette. |
| later (F10) | `flow_run` (lease, heartbeat, end reason, restart count), `runner` (user, name, plugins, reputation, blocks). |

## 3. Generator layers (compile, `client/lib/gen/*.js`)

Fixed order inside `assemble` (→ `assemble-v6`):

1. DEM → **height edits**
2. **openings** (tunnel portals remove terrain triangles)
3. **cover** (albedo + cover map, §6)
4. per feature, its symbol's layers, in stack order:

| layer | for | parameters |
|---|---|---|
| `surface` | line | profile SAN, width, lift |
| `repeat` | line | segment or model SAN, spacing, side offset, follow ground or level |
| `scatter` | area | collection SAN, density, min spacing, max slope, excludes (roads, buildings, water), edge thinning |
| `extrude` | area | wall/roof materials, height, roof shape (existing footprint logic) |
| `place` | point | model SAN (existing tree logic) |
| `paint` | area / line buffer | material SAN, blend width, edge noise |
| `check` | line | max cross-slope → flag only (D5) |

Values accept the existing `{prop, times, plus, min, max, else}` form.
Symbol editor: filter builder, layer stack (add, reorder, toggle), each
layer's form, live 3D preview on a sample feature, version history, "apply
to world".

## 4. Terrain shaping (D5, D6)

- **Sculpt tool** (page, Land → Shape): raise, lower, smooth, flatten, level
  to height, flatten along line (width, max gradient). Size, strength,
  undo/redo, live preview, neighbour's ground drawn locked. Save → new height
  edit → tile changed → Submit/approval as today.
- **QGIS**: the downloaded project has the land's height layer as an editable
  raster; saving writes a new height edit. The Land panel says raster
  painting in QGIS relies on plugins; the page tool is the main one.
- **Road check**: flagged spots shown in the page and in the Submit dialog.

## 5. Vocabulary — OSM starter set (D7)

| kind (OSM key) | geometry | values seeded | properties seeded |
|---|---|---|---|
| `highway` | line | motorway, trunk, primary, secondary, tertiary, unclassified, residential, service, track, path, footway, cycleway, steps | `width`, `lanes`, `surface`, `bridge`, `tunnel`, `lit`, `oneway` |
| `railway` | line | rail, light_rail, tram, narrow_gauge, funicular | `gauge`, `electrified`, `bridge`, `tunnel` |
| `aerialway` | line | cable_car, gondola, chair_lift, drag_lift | — |
| `barrier` | line | wall, retaining_wall, fence, hedge, guard_rail, kerb | `height`, `material` |
| `waterway` | line | river, stream, canal, ditch | `width` |
| `building` | area | yes, house, residential, barn, chalet, church, commercial, industrial, garage | `building:levels`, `height`, `roof:shape`, `roof:colour`, `building:material` |
| `landuse` | area | forest, meadow, farmland, vineyard, orchard, grass | `leaf_type`, `leaf_cycle` |
| `natural` | area | wood, scrub, heath, grassland, bare_rock, scree, glacier, water, wetland, sand, shingle | `leaf_type`, `water` |
| `natural_point` | point | tree, rock, stone, peak, spring | `genus`, `species`, `leaf_type`, `height`, `circumference` |
| `man_made` / `advertising` / `highway` points | — | placed as products, not drawn | ports per product |

swisstopo mapping examples (admin table, editable): TLM Wald → `landuse=forest`;
Wald offen → `landuse=forest` + `wood:density=sparse`; Gebueschwald →
`natural=scrub`; Fels → `natural=bare_rock`; Geroell → `natural=scree`;
Gletscher → `natural=glacier`; Stehende Gewaesser → `natural=water`.

Starter symbols: one per highway value (profile + kerb/guard rail where
typical + lamps where `lit=yes`), walls/fences/hedges, forest by `leaf_type`,
scrub, rock/scree/glacier/water materials, a default house extrusion.
Starter products: a handful of CC0 trees, bushes, rocks, a street lamp, a
billboard, a bus, a tunnel portal, a bridge deck.

Test data: an OSM extract of the fixture area loaded into a test land;
swisstopo TLM for the same area as a cover source.

## 6. Land cover (D8, D9)

- **Admin → Ground cover**: add a source (GeoServer layer), extent,
  priority, map its values to OSM tags (table + map preview). Every source
  reaches the world as a **class raster** through GeoServer's WMS, like the
  albedo does today — a vector source (TLM, OSM) is published by the operator
  with a style that paints each class in its own colour (the panel generates
  that style as a file to download), a raster source (WorldCover) already
  is one. GeoServer stays a raster server. Suggested:
  swissTLM3D Bodenbedeckung/Wald/Gewässernetz (CH/FL), OSM and ESA
  WorldCover (Europe), CORINE (fallback). Every source's attribution in the
  page credits.
- **Blend** (in the tab): per pixel, nearest class borders (vector edges,
  raster steps) become soft transitions with edge noise and per-class
  width; slope and height adjust (rock shows through on steep ground, snow
  on high ground) as symbol parameters, not a biome system. The cover map
  also thins scatter at edges.
- **Output**: a `cover` atom per tile writes albedo + cover map; the file
  server exposes the latest published one at a stable address for the page
  map and QGIS (a lookup, not a computation).
- **On land assignment** the class raster inside it is traced into shapes
  (in the assigning admin's tab) and stored as the land's own features.
- The orthophoto albedo (0106) stays as an optional source.

## 7. Live layer (D1, D2, D13)

- `client/js/live.js`: live parts of published instances over the splats
  (glow, screen texture, rotation) and movers as meshes on their routes
  from the world clock. Polls `live_state` and `mover` by rev.
- Build panel: a selected object shows its ports and current values;
  builders set them by hand.
- Clicks and region enter/leave write `world_event` rows (rate-limited).

## 8. Flow editor (D10, D11)

Reference: `wireon-process-editor` (ELX format, API notes, plugin XML
samples). Copied, split to the 400-line rule, restyled to splatworld's
design: `src/elx/*` (IR, parse, serialize, nets), `src/plugins/*` (plugin
XML parse, registry), `src/graph/*` (register, import, export, named nets,
subflows, port groups, history, layout), `vendor/litegraph.*`. Its hard
rules carry over unchanged: round-trip byte-identical, layout never in ELX,
names are identity, unknown content preserved, strict structure / union
value connection rule. Not copied: its REST client, dockview shell, jobs,
services, reports, run UI.

**The page**
- Menu → **Flows**: a full-screen view over the world (the world keeps
  running behind it).
- Left: my flows (per land), new, duplicate, delete, rename.
- Centre: the canvas — palette search, drag in blocks, wire, subflows
  (double-click to open), named nets as labels, undo/redo, auto-layout.
- Right: selected block's parameters and constants; flow inputs/outputs.
- Top: Save (into the world, `flow` row + ELX artifact), Validate, Export
  `.elx`, Import `.elx`.
- Layout stored beside the flow in the world (not in the ELX).

**Palette**
- Standard blocks from `elx_plugin`: seeded with the plugin XML set from the
  reference repo; later refreshed from what runners report.
- **World** group: *Read port*, *Write port*, *Move a mover*, *Events since*,
  *World clock*. Each is built only from standard blocks (strings, http
  *make-request-simple*, json), exactly like the http plugin's own composite
  *make-request-simple* is built from other blocks. The URL and the run's
  key reach them through two flow inputs, `world` and `world_key`, which a
  job binds.
- Port picker: *Read/Write port* offer the ports of objects on the flow's
  land (by name, with a "pick in world" button that flies to it).
- Events: flows are started by a job trigger; the world block *Events since*
  pulls what happened. A cron trigger means at most one check per minute —
  stated in the UI.

**How World blocks are written into ELX** — decided by one check on the
test server (first story of F8):
1. If the process server loads a plugin that consists only of XML (plugin
   XML + composite node files, as http's *make-request-simple* is), the
   world ships as such a plugin, `plugin="world"`, and the ELX references
   it — clean and readable.
2. Otherwise World blocks are written inline as their standard blocks,
   grouped in a named subflow the editor recognises on import.
Either way, `/process/validate` on the test server must accept every flow
the editor writes.

**Validation gate** (`make flow-test`): every sample and every World block
round-trips byte-identical, and — when the test server is reachable —
passes its validate endpoint. Skipped with a notice when it is not.

## 9. Phases and stories

| phase | stories (each proven through the page) | after |
|---|---|---|
| **F0 Spec** | Amend SPEC, ARCHITECTURE, CLAUDE.md per §1; artboards for Flows, Symbols, Ground cover, Sculpt. | – |
| **F1 Flow editor** | Open Flows; draw a flow from standard blocks; save; reload; it is there, identical. Import the reference samples; export byte-identical. Validate against the test server. Undo/redo, subflow open/close, named nets. | F0 |
| **F2 Vocabulary** | Kinds and properties seeded from OSM; existing features renamed and still render identically. Load the OSM test extract into a test land; QGIS project shows the new layers and dropdowns. | F0 |
| **F3 Assets v2** | Register a segment, a profile, a collection, a material. Register a lamp, mark its light and `on` port. Register a tunnel portal with an opening. Existing products unchanged. | F0 |
| **F4 Symbols** | Admin builds "highway=secondary" (surface + kerb + lamps if lit) with live preview; the OSM test road renders with it. Editing the symbol leaves published tiles alone until "apply to world". Old build rules render identically after migration. | F2, F3 |
| **F5 Terrain** | Sculpt a road bed with the line brush, save, submit, approve, render. Neighbour's ground locked. Same round trip from QGIS. Steep road flagged in Submit. Tunnel portal opens the terrain. Old terrain-edit shapes converted, render unchanged. | F4 |
| **F6 Infrastructure** | Wall follows the ground; forest scatters a collection and avoids a road; building GLB placed; lamps along a lit road. | F5 |
| **F7 Land cover** | Admin adds swissTLM3D forest/rock/glacier and maps them; map shows blended cover; render shows soft forest edges. Land assignment copies cover in; owner deletes a part in QGIS; approved render shows the clearing. | F4 |
| **F8 World blocks** | Test-server check decides §8 1/2. Place *Write port* on the lamp from the palette with the port picker; save; validate passes; re-import shows the same World block. | F1, F3 |
| **F9 Live** | Owner switches the lamp on by hand; a second player sees the glow within seconds. Owner draws a bus route and schedule; two players see the bus in the same place. | F3 |
| **F10 Running flows** | Runner pool, leases, restarts, price per hour, runner can write only its flow's ports. A process server on the test system runs the lamp flow; the second player sees the lamp change. | F8, F9 |

Parallel lanes: F1 → F8; F2/F3 → F4 → F5 → F6; F4 → F7; F3 → F9.

## 10. Open

- F8's check on the test server (XML-only plugin possible or not).
- Which process server writes (create/update bodies) take XML vs JSON — the
  reference repo lists this as unconfirmed; matters only from F10.
- Cron granularity on the test server (whether faster than one minute is
  possible) — matters only from F10.
