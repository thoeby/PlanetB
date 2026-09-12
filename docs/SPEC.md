# splatworld — product specification

What a person meets, in what order, what every element does, what every state
means, and how each flow is proven. Written to be implemented as-is. Where a
choice was not yet made by the owner of the project it is made here and listed
in §9 so it can be overridden in one place. Nothing else in this document is
optional.

Words: **player** — anyone signed in. **object** — a catalog product placed
in the world (an `instance` row). **land** — an owned area. **tile** — a
compile unit of the world at one zoom. **submission** — what stands on a
tile, handed to the owner for approval before it is rendered.

---

## 0. Entities and their states

Every state below is visible to the user in words, in the place the entity
appears. No state is inferred from a number.

### 0.1 Ground
The DEM coverage the operator chose. One per world. Where it reaches there is
world; outside, "off the edge of the world". Ground is always drawn and always
walkable, whether or not anything has been rendered there. Ground has no
state.

### 0.2 Tile
| state | meaning | who sees it how |
|---|---|---|
| **ground** | nothing built, nothing rendered | plain terrain, ground colour |
| **changed** | something on it was saved since the last publish; not yet submitted | terrain + models; owner's HUD counts it as "not submitted" |
| **awaiting approval** | the owner submitted what stands here for a decision | same; the tile is listed for the approver |
| **refused** | the approver said no, note attached | same; the note shown to the owner; tile is `changed` again |
| **queued** | approved; render jobs open in the pool, unclaimed | same, plus "queued" on the tile in the map and in Land |
| **rendering** | a tab holds it; progress known | "rendering 40 %", who is rendering |
| **published** | the render landed | splats for everyone |
| **stale** | published, but a finer tile under it was published since; its rebuild job is in the pool | last published splats until replaced |

Approval comes **before** rendering, like a permit comes before building.
What is approved is what stands on the tile (the saved objects and land
features, seen in place as models). Rendering is then mechanical: a
deterministic compile, hash-checked, that publishes on landing without a
second decision.

Every tile of the ladder, fine (z ≥ 14) and coarse (z < 14), is a render
job in the same pool. A coarse tile is rebuilt from its published children
(merge, no training). Nobody owns coarse tiles and nobody is asked to pay
for any job: a price on a job is optional; the default is 0, and people
take 0 jobs because rendering the world is how you contribute to it.

### 0.3 Object (instance)
| state | meaning |
|---|---|
| **placing** | being positioned; not saved; only this tab sees it |
| **saved** | a row exists; everyone sees the model, marked "not yet rendered" |
| **awaiting approval** | the owner submitted its tile for a decision |
| **refused** | the approver said no; the object stays saved, the note is shown on it |
| **approved** | its tile is queued or rendering |
| **published** | its tile is published with it inside |
| **removed** | deleted; the tile becomes `changed` |

### 0.4 Product (catalog entry)
| state | meaning |
|---|---|
| **draft** | uploaded, not yet registered |
| **listed** | anyone can find and place it |
| **withdrawn** | by the maker; existing objects stay, no new placements |
| **blocked** | by an admin, with a note; as withdrawn plus the maker is told |

### 0.5 Land (area)
Has: a name, an owner, a boundary, a detail level (finest zoom that will be
rendered), grants (who may build, who may approve), and everything on it.
Land has no state; its tiles have.

### 0.6 Render job
| state | meaning |
|---|---|
| **open** | in the pool, price 0 unless the owner attached one |
| **claimed** | a tab is working; progress 0–100; expires if silent 5 min |
| **done** | the tile is published; any price paid to the renderer |
| **failed** | error text kept; back to `open` automatically, error shown to the owner |

### 0.7 Player
Has: email, **display name** (required at first sign-in, unique), balance,
roles (`admin` or not), lands owned, grants received, products made.

---

## 1. Roles and what they may do

| action | anyone | player | land builder (grant `build`) | land owner | — | product maker | admin |
|---|---|---|---|---|---|---|---|
| walk, look, follow a link | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| see models not yet rendered | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| browse catalog | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| place / move / remove objects | | | that land | own land | | | |
| shape land in QGIS | | | that land | own land | | | |
| submit land for approval | | | | ✓ | | | |
| render from the pool | | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| approve / refuse | | | | own land | | | |
| grant / revoke on land | | | | own land | | | ✓ |
| register a product | | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| withdraw own product | | | | | | ✓ | ✓ |
| block a product | | | | | | | ✓ |
| assign land to a player | | | | | | | ✓ |
| define properties | | | | | | | ✓ |
| set up the world (ground, GeoServer) | | | | | | | ✓ |

The database enforces every row of this table. The interface never shows a
control the current player may not use; it shows why instead ("owner: Anna
— ask for a build grant").

---

## 2. The page

One page. The 3D view fills it. Everything else is layered over it and can be
dismissed. There are no other pages; old addresses redirect here.

### 2.1 Always visible
- **Position line**: land name (or "unclaimed ground" / "off the edge of the
  world"), owner's display name, your right here ("you may build here",
  "read only", "you may approve here"), coordinates, heading.
- **Player chip**: display name, balance, one click → Account.
- **Attention chip**: count of things waiting for *you*: submissions to
  approve on my land, refusals to read, jobs done, products blocked. Click → the list.
- **Mode line**: "walking" / "flying" / "building" / "reviewing". Building
  and reviewing are entered by a visible button and left by the same.
- **Map button**: opens the map (2.3).
- **Menu**: Land · Build · Catalog · Render · Approve · Share · Account ·
  Admin (admins) · Setup (admins, only until ground is set). Each opens its
  panel; one panel open at a time; Escape closes.

### 2.2 The world view
- Terrain everywhere the ground reaches, from the DEM tiles, shaded by
  height and slope. It streams by distance like the splat tiles do, and is
  what you walk on and what a placement ray hits. When a published splat
  tile is loaded, it is drawn on top of the terrain; the terrain stays as
  the collider.
- Land boundaries drawn on the terrain: yours in one colour, others' in
  another, both with the name floating at the centroid when within 500 m.
- Objects: every saved object is drawn as its model. Not yet published: model
  with a visible "unrendered" treatment (a wireframe overlay or a tint —
  designer's choice, but distinguishable at 50 m). Published: inside the
  splats, no model.
- Tile state overlay (toggle, default off): fine tiles outlined and labelled
  by state (§0.2).
- Movement: WASD/arrows + mouse look; Shift runs; F toggles fly; Space
  jumps; all listed in a "Controls" popover reachable from the menu. Touch:
  left stick / right drag. Player collides with terrain and with published
  splat ground; models are walk-through until rendered (decision §9.4).

### 2.3 Map
A 2D overlay of the whole coverage: hillshade from the ground, land
boundaries with names, tile states as coloured fills (fine tiles only,
coarse as a faint grid), objects as dots when zoomed in, other players'
positions if they are sharing them (off by default), your position and
heading. Click anywhere on ground → "Go there" (teleport). Click land →
its card (name, owner, what's on it, "go", "share"). Search box: land name,
player name, product name → results on the map. Layers toggle: boundaries,
tile states, objects, players.

The map's data comes from the same GeoServer (WMS of hillshade, land, tile
layers) so it is the same picture QGIS shows.

### 2.4 Land panel
- **My land**: list of lands you own or have grants on, with name, size, how
  many objects, how many tiles in each state, and per land: Go · Share ·
  Submit · Grants (owner) · Rename (owner).
- **This land** (the one you stand on): the same card for whoever's land it
  is; if not yours, the owner's name and "ask for a build grant" which sends
  the owner a request (§3.11).
- **Shape this land in QGIS**: a button that downloads a QGIS project
  already connected to this world (§2.11). Next to it, the three steps in
  one line each: open, draw, save. Nothing about terminals.
- **What's on it**: the objects, each with name, state, placed by, when;
  click → selects it in the world and flies you to it; from here: Remove.
- **Get land**: for players with none: "Land is assigned by an admin" with
  the admin's name(s) and a "request land" button that sends a request
  (§3.2). (Decision §9.1.)

### 2.5 Build panel (building mode)
Entered by "Build" in the menu or B; only enabled when standing on land you
may build on, otherwise the button says why.
- **Pick**: catalog search with pictures, filtered to listed products;
  recent and favourites first. Pick → the model follows the cursor on the
  terrain, snapped to ground, yaw facing you. Click places it (state:
  placing). Escape drops it.
- **Selected object** card: name, maker, position, yaw, scale, height offset
  (numbers editable), Duplicate · Remove · Deselect.
- **Handles** in the world on the selected object: drag to move along the
  ground; a ring to rotate; a corner to scale uniformly; a vertical handle
  for height. Snap toggle (0.25 m / 15° / 0.1) default on. Undo/redo (Z /
  Shift-Z, and buttons) over the session.
- **Save**: one button, and Ctrl-S. Until saved, nothing exists for others;
  after, objects are `saved` and visible to everyone as unrendered. Leaving
  building mode with unsaved objects asks: Save / Discard / Stay.
- **Selection in the world**: click any object you may edit to select it;
  click another player's object shows its card read-only (name, maker,
  owner of the land).
- **Limits shown, not enforced silently**: objects per tile, model size
  (footprint and height), distance from boundary. Placing beyond a limit is
  refused with the limit stated.
- After Save: the panel shows "N tiles changed — Submit for approval" with a
  Submit button that opens the Submit dialog (2.7) pre-scoped to this land.
  A builder with a grant sees "Saved — Anna decides when to submit".

### 2.6 Catalog panel
- **Find**: search, kind, licence, maker, "mine", sort by name / newest /
  most placed. Cards with picture, name, maker, size (m), licence, price if
  any, times placed.
- **Product page**: 3D preview (orbit), properties (as defined by admins for
  its kind), licence text, maker (display name), placed-count, "Place this"
  (enters building mode with it picked, if allowed where you stand).
- **Register a product**: drop a GLB → preview, automatic size in metres,
  triangle and texture size shown with the world's limits; Name; Kind
  (admin-defined); its kind's properties (admin-defined); Licence; Price
  (0 by default; editions optional, collapsed under "Sell it" — decision
  §9.6). Register → `listed`. Duplicate model → "this is already product X
  by Y" with a link; no second entry.
- **My products**: list with times placed, Withdraw, Edit name/properties
  (model is immutable; a new model is a new product).

### 2.7 Submit dialog (for approval)
Opened per land by the owner. Shows before anything is sent:
- the changed tiles and what changed on each (objects added / moved /
  removed, features changed) — this is what the approver will see;
- an optional note to the approver.
Submit → tiles `awaiting approval`; the land's approver is notified. When
the owner is his own approver, the dialog says so and offers "Submit and
approve" in one step.

Once approved, the render jobs open by themselves (§5.2). The owner may
attach a price to them from Render → Mine ("attach 5 credits to each") to
attract renderers sooner; not attaching one is normal.

### 2.8 Render panel
Three lists, one switch:
- **Mine**: the approved tiles of my land with state, progress, who is
  rendering, "attach a price", "render it myself". Failed → error text; the
  job is already back in the pool.
- **Pool**: open jobs, nearest first: land name, owner, tile (fine or
  coarse), price if any, estimated minutes, "what this needs" vs "what this
  tab has" (WebGPU, VRAM) — greyed if this tab cannot. "Take" claims one;
  "Take until I stop" keeps taking. Coarse rebuild jobs are listed the same
  way, owner "the world".
- **This tab**: what it is doing now, progress, log (collapsed), stop.
  "Work in background" and "pace for playing" toggles.
- Earnings this session and total, with a link to Account.
A job this tab took shows progress on the tile in the world and in Mine of
the owner, live. When it lands, the tile is published; nothing further.

### 2.9 Approve panel (reviewing mode)
For land owners. Approval is of what stands on the land, before it is
rendered.
- **Waiting for me**: submissions on my land, nearest first: tile,
  submitted by (me or a builder with a grant), when, what changed (objects
  added / moved / removed, features changed), the note, "Review".
- **Review** flies you there, enters reviewing mode: the changed objects
  outlined; a switch Before / After that hides and shows them in place;
  Approve · Refuse (note required, min 10 characters) · Later.
- Approve → the tile is `queued`; its render jobs open in the pool; the
  submitter is notified. Refuse → tile back to `changed`; the submitter sees
  the note on the land card and on each refused object.
- **History**: my decisions with notes.

### 2.10 Share panel
- Copy link to here (position + heading). Copy link to this land (its
  centre). Copy link to the selected object.
- Opening a link: you arrive there. If ground has not streamed yet a
  "loading ground" message; never a fall.
- "Share my position on the map" toggle (default off).

### 2.11 QGIS project (download from Land)
The download is a `.qgs` generated for this world and this player:
- A PostgreSQL connection to the world's database with a login of this
  player's own embedded in it (REFACTOR-direct-pg.md S2/S3: it was WFS-T
  through GeoServer, as one operator, until then).
- Layers: land (yours editable, others read-only by RLS), road, forest,
  water, footprint, terrainmod, tree (points), objects (points, read-only —
  objects are placed in the page), tile state (read-only, styled by §0.2),
  ground hillshade (WMS), catalog (non-spatial, for the dropdowns).
- Forms: every property from Admin as the right widget (dropdown for
  choices, range for numbers, text otherwise); `model` on tree as a
  dropdown over the catalog layer showing name + maker; required fields
  enforced.
- Saving writes straight to the database, under the same row-level security
  as the browser; the trigger marks tiles `changed`; the page shows it within
  30 s without reload. Land features go through the same
  Submit → approval → render path as objects.
- The land panel says which player's project it is and when it was
  generated; a project older than a properties change shows a banner in
  the page: "your QGIS project is out of date — download again".

### 2.12 Account panel
Display name (edit), email, sign out, balance and ledger (paid, earned,
bought), my lands, my grants, my products, notifications with read state,
"delete my account" (objects stay, attributed to "a former player"; land
returns to the admin).

### 2.13 Admin panel (admins)
- **Properties**: per kind (land, road, forest, water, footprint,
  terrainmod, tree, and each product kind): add, rename, reorder, set
  choices, required, delete (shows how many features/products use it;
  deletion keeps stored values but hides the field).
- **Kinds**: add a product kind; add a drawable kind (creates the QGIS
  layer on next download).
- **Land**: map with all land; assign land to a player by drawing or by
  choosing a tile range; transfer; requests for land (§3.2).
- **Players**: list, roles, make admin, block.
- **Products**: all, block/unblock with note.
- **World**: ground coverage in use, GeoServer status, storage used,
  maintenance queue (§5.3), rules (the existing build rules, read-only
  here; editing stays where it is until decided).

### 2.14 Setup (admins, first run)
Account (first player is admin) → display name → GeoServer address + admin
login → "Connect" (asks its WCS what it publishes; nothing is created on it,
REFACTOR-direct-pg.md S4) → list of coverages
→ pick → "This is the ground". Then the page reloads into the world at the
coverage centre. Setup is available from any browser to an admin, not only
the server's own machine. The QGIS admin project (all land editable) is
offered here as a download.

### 2.15 Notifications
Delivered in the attention chip and in Account: submission waiting (owner),
approved / refused with note (submitter), job done / paid / failed
(renderer, owner), tile published (owner), product blocked (maker), build grant requested / given
(owner / player), land assigned (player), QGIS project out of date (owner).
Each notification has one action that goes to the thing.

---

## 3. User stories and flows

Format: preconditions → steps (what the user does / what they see) →
failures (what they see instead) → postconditions → validation (the browser
test that proves it, run against a real database and GeoServer with a small
DEM fixture).

### 3.1 First run (operator)
Pre: fresh install, GeoServer with a DEM coverage.
1. `splatworld run` → browser opens on the page over black with a Setup
   panel open.
2. Email + password → "your name" → Setup: GeoServer URL, login, Connect →
   "N coverage(s)" → coverage dropdown → pick → "Use this ground".
3. Page reloads; terrain visible; position line "unclaimed ground";
   attention chip empty; Land panel says "no land yet — assign land in
   Admin".
Fail: wrong GeoServer URL → "nothing answers at …"; wrong login → "login
refused"; no coverage → "this GeoServer publishes no raster coverage;
publish your DEM as a coverage store and Connect again" with a link to the
GeoServer docs.
Post: `ground` row; first player is admin.
Validation: `e2e/setup.spec` — does the above against the fixture, asserts
terrain mesh present at the coverage centre and `player.grounded`.

### 3.2 Getting land
Pre: signed in, no land.
1. Land → "Land is assigned by an admin" → Request land: a note ("near
   Visp, ~2 ha") → sent.
2. Admin sees it in Admin → Land → Requests; draws a boundary on the map
   (or types a tile range) → Assign to <player> → name.
3. Player is notified; Land panel lists it; Go flies there; boundary drawn.
Fail: overlapping existing land → refused with the overlap shown.
Post: `area` row with owner; its fine tiles are `ground` (not `changed` —
claiming land renders nothing).
Validation: `e2e/land.spec`.

### 3.3 Shaping land in QGIS
Pre: own land.
1. Land → "Shape this land in QGIS" → download `.qgs`.
2. Open in QGIS: layers load, hillshade visible, your land editable.
3. Draw a forest inside the land, form: type dropdown → Save.
4. Back in the page within 30 s: the tile shows `changed`, Land card says
   "1 tile changed — Submit".
5. Place a tree point, model dropdown → Save → same.
Fail: drawing outside your land → the database's refusal surfaced by QGIS as
"that is not your land"; page unaffected. Stale project → banner in page.
Post: feature rows; tiles `changed`.
Validation: `qgis/roundtrip.spec` — headless QGIS (`qgis_process` or
PyQGIS) opens the generated project, inserts through the same connection,
asserts rows and tile state. This replaces the WP0.11 checklist.

### 3.4 Building
Pre: standing on land you may build on.
1. Build → building mode; player stops; cursor free.
2. Pick → search "bench" → card → model follows cursor on the terrain →
   click → placed; handles appear; drag to move, ring to turn.
3. Pick "house" → place → the card shows size 12 × 9 × 7 m; the house
   snapped to ground; adjust height handle to sink foundations.
4. Save → "2 objects saved · 1 tile changed" → Submit button shown.
5. Leave building mode → walking; objects stay as unrendered models; a second
   player standing there sees them the same way with "not yet rendered".
Fail: pick allowed nowhere here → "you may not build here (owner Anna)";
beyond a limit → limit stated, object turns red, cannot be saved until
moved; save fails (network) → objects stay `placing`, retry button.
Post: instance rows; tile `changed`.
Validation: `e2e/build.spec` — two browser contexts: A places and saves; B
sees the model at the position within 30 s with the unrendered treatment;
A's undo removes one; save; B sees one.

### 3.5 Submitting for approval
Pre: land with `changed` tiles.
1. Submit (from Land or Build) → dialog: "3 tiles · 2 objects added, 1
   moved · forest changed on 1 tile" with the changes listed per tile; note.
2. Submit → tiles `awaiting approval`; the owner is notified (or "Submit and
   approve" if that is you).
Fail: nothing changed → Submit disabled with "nothing to submit"; a tile
already awaiting → listed as such, not re-submitted.
Post: submission rows; tiles `awaiting approval`.
Validation: `e2e/submit.spec`.

### 3.6 Approving
Pre: a submission on my land.
1. Attention chip "1" → Approve → "z16 · by Ben · 2 objects added" →
   Review → flown there, reviewing mode, Before / After.
2. Approve → tile `queued`; render jobs open (the fine tile now, coarse
   parents after it publishes); Ben notified.
   Or Refuse → note "the house is inside the road" → tile `changed`; Ben
   sees the note on the land card and on each refused object.
Fail: submission superseded (a newer save on that tile) → "this changed
since it was submitted" and only Later is enabled; the submitter is asked
to submit again.
Post: tile `queued` with open jobs, or `refused_note`.
Validation: `e2e/approve.spec` — both branches.

### 3.7 Rendering
Pre: a job in the pool; this tab has WebGPU (or the job needs none: coarse
rebuilds).
1. Render → Pool → "Anna's land · z16 · ~4 min · needs WebGPU ✓" or "the
   world · z13 rebuild · ~20 s".
2. Take → This tab: assembling… framing… training 37 %… done → "published".
   Anna's tile shows `published`; everyone sees the splats; if Anna attached
   a price it is now Ben's.
3. The parent tile turns `stale` and its rebuild job appears in the pool.
   The same tab takes it if "Take until I stop" is on.
   Or from Render → Mine: "Render it myself" takes my own jobs in this tab.
Fail: claim lost (tab idle 5 min) → "the job went back to the pool"; error →
job `failed` and immediately `open` again, error text to the owner, tab
moves to the next.
Post: `published_version`; parent `stale` with an open job.
Validation: `e2e/pool.spec` — B takes A's job in a WebGPU-capable headless
run (or the CPU trainer fixture), the tile publishes, C sees splats, the
parent rebuild job appears and completes.

### 3.8 Visiting and sharing
1. Share → Copy link to here → paste to another player.
2. They open it: page loads, terrain streams, they stand at the spot facing
   the heading; the position line shows whose land it is.
3. Map → search "Anna" → her land → Go.
Fail: link outside the coverage → arrive at the nearest ground edge with
"that place is off the edge of the world".
Validation: `e2e/visit.spec`.

### 3.9 Registering a product
1. Catalog → Register → drop GLB → preview, "12.1 × 9.4 × 7.0 m, 48 k
   triangles, 2 textures (2048²)" against limits → name, kind "building",
   properties (from Admin), licence → Register.
2. Listed; appears in Pick for everyone.
Fail: over limits → stated, Register disabled; duplicate → link to the
existing product.
Validation: `e2e/catalog.spec`.

### 3.10 Admin defines a property
1. Admin → Properties → kind "forest" → Add "leaf_type", choices
   broadleaved / needleleaved, required.
2. Owners see the "QGIS project out of date" banner; the next download has
   the dropdown; the Build panel's product forms (for product kinds) update
   without reload.
Validation: `e2e/admin.spec` + the QGIS round trip asserting the widget.

### 3.11 Build grants
1. Standing on Anna's land → Land → "ask for a build grant" → note → sent.
2. Anna: notification → Land → Grants → Ben · build → Give.
3. Ben: notified; Build now enabled there; Anna sees Ben's objects as
   "placed by Ben".
Validation: `e2e/grants.spec`.

### 3.12 Failure and recovery, always
- API unreachable: a bar "can't reach the world — retrying" and the page
  keeps rendering what it has; no white page.
- Ground tile fails to cut: that tile shows a hatched "no ground data" area
  and the log says the WCS error; the rest of the world unaffected.
- Token expiry: silent refresh; if refused, "sign in again" in place with
  the current work kept.
- Any write refused by the database: the reason in words next to the
  control that caused it, never only in the console.

---

## 4. End-to-end validation

One script, run in CI against a real Postgres, PostgREST, the Python server,
a GeoServer container with the fixture DEM (a 4 × 4 km cutout), headless
Chromium with WebGPU (SwiftShader-lane or the CPU trainer fixture) and
headless QGIS:

1. 3.1 → 2. 3.2 (admin assigns to A) → 3. 3.3 (A shapes in QGIS) →
4. 3.9 (B registers a product) → 5. 3.4 (A builds with it, C sees the model)
→ 6. 3.5 (A submits) → 7. 3.6 (A approves; jobs open) → 8. 3.7 (B renders
at price 0; C sees splats; the coarse rebuild runs) → 9. 3.8 (C follows
A's link) → 10. 3.11 (C asks, A grants, C builds, A submits) → 11. 3.6
refuse branch → 12. 3.10 (admin adds a property; A's project banner; QGIS
round trip shows the widget).

Every step asserts what the user sees (DOM text and a screenshot diff of the
3D view at the spot), not only rows. This script is the gate; the pgTAP and
unit suites stay underneath it.

---

## 5. Background processes

### 5.1 Ground cutting
On first request for a DEM tile, the server asks the GeoServer WCS for that
tile's bounds, stores it immutable, serves it. The viewer requests terrain
tiles around the player by distance; the compiler requests the ones it needs
and pins their hashes. A failed cut is retried with backoff and shown (3.12).

### 5.2 Render pipeline (unchanged: assemble → frame → train → sog)
A fine tile's jobs open when its submission is approved. Each job's progress
and stage are written by the working tab every 10 s and read by everyone
who shows that tile. A landed render publishes at once (deterministic,
hash-checked); nobody is asked again.

### 5.3 Coarse tiles
When a fine tile is published, its parent is marked `stale` and a rebuild
job (merge from published children, no training) opens in the same pool at
price 0. Anyone takes it like any other job. A stale coarse tile keeps
showing its last published version until replaced. Coarse tiles contain
only what was approved below, so they need no approval of their own.

### 5.4 Estimates
Time and cost estimates are rolling means of the last 20 jobs per zoom,
stated as estimates.

### 5.5 Prices on jobs
Optional. Attached by the owner to his own approved jobs, held from his
balance, paid to the renderer when the job lands, returned if the owner
withdraws it before anyone claims. Nothing in the pool requires a price.

---

## 6. Limits (shown wherever they apply, set in Admin → World)

Objects per fine tile; model footprint and height; triangles and texture
size per product; land size per player; jobs per tab; price minimum for the
pool to list a job to strangers. Defaults are the current ones in code where
they exist; where none exists: 200 objects/z18 tile, 60 × 60 × 60 m,
200 k triangles, 4096² textures, 25 ha land, no minimum price.

---

## 7. What is removed or repurposed

- Anonymous three-verifier publishing and trust scores: removed from the
  path; hash checks remain internal.
- Spot checks: removed.
- OSM seeding, ortho draping, the standalone editor, importer whole-coverage
  fetch: removed.
- The existing `areas` panel (grants, proposals): merged into Land →
  Grants; proposals become build grants + the normal save (an object placed
  by a grantee is simply an object placed by a grantee).
- `edit.html`: kept in the repo, not linked; it is not part of the product.

---

## 8. Definition of done, per surface

A surface is done when a player who has not read this document does its
story in §3 without help, every failure in that story shows its message in
place, and the e2e step for it is green.

---

## 9. Decisions

Made by the owner of the project:

1. Every tile, fine or coarse, is a render job in one pool; prices are
   optional and 0 by default; rendering is contribution.
2. Saved objects are visible to everyone immediately as unrendered models.
3. Approval is of what stands on the land, **before** rendering; a landed
   render publishes without a second decision; a renderer is paid (if a
   price exists) when the job lands.
4. Land is assigned by an admin on request — placeholder until decided.
5. The land owner approves his own land (and what grantees build on it).

Still open — implemented as stated below until decided:

6. Fine/coarse split at z14, default detail 18.
7. QGIS project generated per player with a scoped token; the admin project
   edits all land.
8. Unrendered models are walk-through; published splats collide.
9. Display names required and unique.
10. Product price/editions collapsed under "Sell it"; buying unchanged.
