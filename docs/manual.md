# splatworld — install, deploy and use

What exists: the stories of `docs/SPEC.md` §3, each proven through the page by
`make player-run` (`PLAYER-RUN.md`, `TASKS-foundation.md`, `TASKS-flows.md`,
state in `PROGRESS.md`). A world on the operator's own elevation is compiled
into Gaussian-splat tiles by browser tabs and streamed back into a
first-person viewer: every tile with nothing finer under it is trained on
WebGPU (brush, `client/vendor/brush`), every coarser one merged from its
children. Players own land, shape its ground, draw on it in the page or in
QGIS, place catalog products, grant rights, submit and approve what they
built, pay bounties, and wire flows that process servers of their own run.
What is written but unrun is in §8.

## 1. What runs where

| process | role | port |
|---|---|---|
| PostgreSQL 16 + PostGIS | the world, jobs, atoms, ledger, auth; QGIS connects to it as the player | 5432 (loopback in compose) |
| PostgREST 12 | the only API | 3000 (loopback in compose) |
| nginx, or the `splatworld` server | immutable file store `/assets /tiles /jobs /geo`, static client under `/app/` | 8081 |
| GeoServer 2.26 | publishes the operator's ground layers (elevation over WCS; albedo, shade, cover over WMS), nothing else | 8083 (loopback in compose) |

The `splatworld` server (`server/`, `docs/server.md`) replaces nginx on a
machine that has none built with the DAV module, and supervises PostgREST
itself. It also cuts a `/geo` ground tile from the GeoServer the first time a
browser asks for it.

The server runs no atom and renders nothing. Every atom (dataset, train,
merge, sog) runs in a player's browser tab (Invariant 9). There is no cron and
no worker process; `tools/` are run by a person on a dev or ops box.

## 2. Install

### 2a. One machine, no Docker

PostgreSQL with PostGIS and a PostgREST binary, then:

```sh
python -m pip install -e ./server
splatworld run               # creates the database on first run, opens the browser
```

`docs/server.md` has the details for Windows, Debian/Ubuntu and macOS.

### 2b. With Docker

```sh
git clone <repo> splatworld && cd splatworld
cp .env.example .env         # change JWT_SECRET (>= 32 chars) and every password
make up                      # postgres, postgrest, nginx, geoserver
make db-reset                # creates the database and applies db/*.sql
```

`make db-reset` connects with the `PG*` values from `.env`; with compose these
are `localhost:5432`, user `postgres`. It drops and recreates the database, so
run it once at install and never on a live world.

Then open `http://localhost:8081/app/play.html`.

### 2c. Dev box, CI

Ubuntu 24.04:

```sh
apt-get install -y --no-install-recommends \
    postgresql-16-postgis-3 postgresql-16-pgtap \
    libtap-parser-sourcehandler-pgtap-perl nginx-extras webp gdal-bin rsync
pg_ctlcluster 16 main start
su postgres -c "psql -c \"ALTER USER postgres PASSWORD 'postgres'\""
curl -sSL https://github.com/PostgREST/postgrest/releases/download/v12.2.3/postgrest-v12.2.3-linux-static-x64.tar.xz \
  | tar xJ -C /usr/local/bin
pip3 install 'sqlfluff==3.4.2'
cp .env.example .env
npm install                  # eslint + playwright, tooling only
make vendor                  # PlayCanvas, Draco, OpenLayers, fonts for the browser tests
set -a; . ./.env; set +a     # tools/ read PG*, JWT_SECRET, FILES_ROOT from the env
make db-reset
```

`nginx-extras` is the build with the DAV module; `nginx-light` cannot PUT.
`tools/api-test.sh`, `tools/files-test.sh` and `tools/test-tiles.sh` start
their own PostgREST and nginx on `$API_URL` / `$FILES_URL` when nothing is
listening. To run the app itself, `splatworld run` (2a) is the short way.

## 3. Configure

All configuration is `.env` (see `.env.example`):

| variable | meaning |
|---|---|
| `JWT_SECRET` | HS256 secret shared by `login()` in the database and PostgREST. Change it. |
| `POSTGRES_PASSWORD`, `AUTHENTICATOR_PASSWORD`, `GEOSERVER_ADMIN_PASSWORD` | passwords; change all three |
| `FILES_ROOT` | directory of the immutable file store (default `./infra/files`) |
| `PG*` | where `make`, `splatworld` and `tools/` find the database |
| `GEOSERVER_URL`, `GEOSERVER_ADMIN_USER` | the operator's GeoServer; Settings → Setup writes them |
| `ELX_URL` | the process server `make flow-test` validates against; empty skips |

The client finds its endpoints in two `<meta>` tags at the top of each page
(`splatworld:api`, `splatworld:files`). The `splatworld` server rewrites them
to where it is actually listening; behind nginx, edit them for a deployment
that is not on `localhost`. The file store answers CORS, so the client may be
served from another origin.

Compose binds Postgres, PostgREST and GeoServer to `127.0.0.1`; only the file
store (8081, which also serves the client) listens on all interfaces. For a
public deployment put a TLS proxy in front of 8081 and 3000, and edit the
`<meta>` endpoints accordingly. QGIS connects to Postgres directly, as the
player, with a login the database mints (`db/0065_playerroles.sql`): players
on other machines need 5432 reachable, behind TLS. Never expose 8083.

The first account registered is an `admin`; every later one a `player`.

## 4. The ground and the map

Nothing is seeded. In the page, **Settings → Setup**: create the account,
connect the operator's GeoServer, and pick the coverage the world stands on
(`docs/geoserver.md`). The ground is then cut one tile at a time as browsers
walk onto it. Land is assigned by an admin (Survey, F6) or asked for; what is
on it is drawn in the page, in QGIS (`gis/README.md`), or imported by the
operator with `splatworld import` (`docs/import.md`). Every write marks the
covering tiles dirty; that is the work queue.

The player-run's test data around Visp: `infra/seed/README.md`.

## 5. Use

Everything is one page, `/app/play.html`. `/app/setup.html`, `import.html`,
`catalog.html` and `rules.html` redirect to it. **Tab** opens the views —
Build (F1), Automate (F2), Work (F3), Trade & Sell (F4), Play (F5), Survey
(F6) — and the surfaces are on the bar along the bottom (Place, Catalog,
Land, Publish, Terrain on keys 1–5) and the strip along the top (Profile,
Wallet, Settings) (`client/js/apps.js`, `client/js/tabbar.js`).

### Moving

- **Move**: WASD, Space up, Shift down, mouse look after clicking the canvas
  (pointer lock), `F` toggles walk/fly. (Shape and Lines use the clay's own
  camera instead: see Blueprint below.) The ground comes from the finest
  loaded tile's heightmap; colliders block you.
- The viewer polls the loaded tiles every 30 s and swaps in new versions. A
  tile refines into whichever of its children are published
  (`client/js/traverse.js`).
- **Spot check**: when your tab loads a tile someone else published inside an
  area you may write, and you have not checked it for a week, it checks it
  again (`spot_due`, `client/js/spot.js`). A failure marks the tile `suspect`.

### The vocabulary

Since db/0157 the world describes what is drawn in OSM's words. The kind of a
feature is an OSM key — `highway`, `railway`, `aerialway`, `barrier`,
`waterway`, `building`, `landuse`, `natural`, `natural_point` — and which one it
is is a property of the same name: a road is `highway=secondary`, a wood is
`landuse=forest` or `natural=wood`, a pond is `natural=water`, a tree is
`natural_point=tree`. QGIS has one layer per key, and Settings → Vocabulary adds
values and properties to them without a migration.

Nothing that was drawn before changed: db/0157 renamed the kinds (the rows
followed) and moved what used to be the kind into a property. The compiler reads
the new shape and draws the same geometry, to the byte
(`client/test/assemble.test.js`).

### Automate (the flow editor, same page)

- **Tab** opens the views; **Automate** (F2) is the flow editor. It takes the
  window, and the 3D view stops being drawn until it is closed.
- A flow belongs to a **land**: you see the flows of every land you own or may
  build on, and so does everybody else who builds there. Approvers for a land
  can read its flows.
- **New** asks for a name and a land. The canvas is litegraph; the palette is a
  searchable strip above it — type part of a block's name or its group ("strings
  contains") and drag the line onto the canvas. Wire by dragging port to port,
  Delete removes the selection, Ctrl-Z and Ctrl-Shift-Z undo and redo,
  **Auto-layout** lays the blocks out again.
- Double-clicking a filter or a transformation opens its inner flow, with a
  breadcrumb back.
- The **inspector** on the right is about the selected block — its name (unique
  in the flow), its parameters, constants on the inputs no wire reaches, and how
  many slots a repeatable port has. With nothing selected it is about the flow:
  its own inputs and outputs, and how each named net is drawn.
- **Save** writes the ELX into the file store under the sha256 of its bytes and
  moves the land's pointer at it. Two tabs cannot overwrite each other: the
  second is told "this flow was changed in another tab — reload it". Where the
  blocks sit is stored beside the flow, never inside the ELX.
- **Import** takes `.elx` files — the button, or dropping them on the canvas.
  Each becomes a flow of its own on the land, laid out, named after the file.
  **Export** gives back the saved bytes exactly; a flow with unsaved changes is
  told "save first" rather than exported as something else.
- **Validate** asks two things and shows both: the process server, if the
  operator set one in Setup, and what the page can see for itself — one source
  per net, every wired pair allowed, names unique. Each problem is a line under
  the inspector, and pressing it goes to the block. `docs/flow.md` has the
  detail, including what is still unproven.
- **Settings → Setup, step 4** registers the bundled block set with the
  world. Run it once per install, and again after `bash tools/palette.sh` has
  changed the set. The same step holds the address of the process server flows
  are checked against; leaving it empty is a choice, and the page still checks
  what it can.
- A player keeps **process servers** of their own (Server → Add a server…);
  **On <server>** lists its processes, services, jobs and reports, and **Run
  on…** sends a flow and gives the job a key that may set ports on that land
  only (`docs/flow.md`).

### Work (F3)

- The pool, by the kind of work: **All**, **Render jobs**, **Training**,
  **Publish**. A card takes that piece into this tab; a job's detail holds its
  bounty (`set_bounty`). Training needs WebGPU.
- **Settings** shows what this machine renders with, and two switches:
  **Work in the background** — claim, run in a Web Worker, upload, submit,
  publish; the tab heartbeats every 30 s and a claim expires after 5 minutes
  of silence (30 for training, `claim_patience`, db/0173); and **Help render
  the world** — only the deterministic pieces nobody pays for (`dataset`,
  `merge`, `sog`), nearest first, paced to keep the frame rate. `GET
  /progress` (public) is the dashboard.

Ancestors are marked dirty automatically when a child publishes, and a tile
with finer children is merged from them.

### Build (Place, Land, Publish, Terrain), and the wallet

- **Place** detaches the player; click the ground to place the selected
  catalog product. Keys: `G`/`R`/`T` move/turn/size, `X`/`Y`/`Z` axis,
  `]`/`[` or arrows step, `Delete` removes, `Ctrl+Z` undoes — every one of
  them a button as well. A placement is an `instance` row; an `edit`
  grantee's placement becomes a proposal instead.
- **Land**: your land, who may build on it (`direct_edit`, `edit`, `approve`,
  by email), how many approvals publishing needs, **Ask to build here** on
  somebody else's, and **Shape this land in QGIS**.
- **Publish**: **Submit** sends what you built to be rendered; **Approve** is
  what somebody built on your land, waiting for you.
- **Terrain → Shape**: pull the ground up, push it down, lay a road bed
  (`.r32`, `docs/rendering.md` §6).
- **Wallet**: balance and ledger. Escrow is released pro rata by GPU seconds
  when the tile publishes; a cancelled job refunds it.

### Catalog

### Blueprint: the ground as white clay (Build · Shape and Lines)

Shape and Lines open your land as a clay model: white ground, contour lines,
what you changed tinted, a thin ring round the land, and the rest of the world
greyed out. The camera is the clay's own and never locks the pointer:

- `W A S D` fly over the land, `Q`/`E` (or `Space`) go down and up.
- The middle (or right) button drags an orbit; pitch stays between 30° and
  straight down. The wheel zooms to the pointer. `O` swaps to orthographic,
  **Zoom to land** frames the land again.
- `H` is the hand (drag the land), `C` a section: drag a line across the land
  and its profile opens along the bottom.
- Hold `Tab` to peek at the splats through the clay.
- At the pointer: the ground height, how far it is off the operator's
  elevation, the slope and the shaping limit, and a word when something
  matters — `not your land`, `edge blend`, `over limit`, `snapped: …`.
- Three views, on the corner card or `Z` to step through them: **Solid** (the
  clay in a hard light, so a bank or a pit reads as shape, and no colour),
  **Contours** (flat clay with height lines every 2 m, bold every 10, and
  what you changed as colour: blue raised, red lowered, hatched while
  unsaved) and **Grid** (a metric grid, 5, 25 or 100 m as you are near or
  far). Your neighbours' lines and areas can be switched off.
- Opening Shape or Lines shows a loading screen until the land, its
  elevation and the clay are there.
- While the clay is up the rest of the world stops streaming, and a still
  view is redrawn only a few times a second.

### Shape (Build · 4)

A toolbar over the land, top left: the land, the tools, undo and redo, how
many strokes are unsaved, **Save**, **Put back** and the strokes list. Picking
a tool flaps out its card (size, strength, falloff and its curve, circle or
square, and whatever else that tool reads); picking it again folds it. The
brush on the clay is a disc at its true size, shaded by its falloff.

| Key | Tool | What it does |
|-----|------|--------------|
| `R` | Raise | up while held; `Shift` lowers |
| `M` | Smooth | evens the ground under the brush |
| `G` | Flatten | to the height where the stroke began; a fall (%) and its direction make a terrace drain, `Ctrl`-drag turns the arrow |
| `L` | Level | to a set height; `Alt`-click takes it from the ground, or pick a house floor |
| `B` | Along line | a road bed: click its path or pick one of the land's lines, width, shoulder and gradient; written as one stroke |
| `X` | Put back | rubs shaping out, back to the elevation |
| `H` / `C` | Hand / Section | |
| `[` `]` | | brush smaller / bigger |

The operator's limit (Admin → Shape: how far up and down, default 8 m) holds
per cell and the brush says so; the brush fades within 4 m of your boundary
unless the operator turned the edge blend off. Strokes are listed newest
first: click one to undo back to it. **Put back** asks first, then puts the
whole land back as one undoable stroke. Leaving Shape with unsaved strokes asks
Save, Discard or Stay. A save that does not go through is kept on this machine
and offered again when you come back.

### Lines (Build · 5)

Roads, paths, streams, walls and hedges, drawn on the clay; they never move
the ground (use **Lay bed** for that). Pick a kind in the palette — one entry
per kind and class, recent ones first, type to filter, `1`–`9` to pick.

- `L` draws: click nodes, hold-drag to sketch (simplified on release), `Enter`
  or a second click on the last node ends it, `Esc` drops the last node.
  Nodes snap to line ends, your boundary, contour and grid; deep in somebody
  else's land a node is refused. Hold `Alt` to keep each node at the first
  one's height, walked along the slope.
- `V` selects and edits: drag nodes and handles, click a curve to insert a
  node, right-click for corner/smooth, split and delete; the handle at the
  side sets the width at that node.
- The selected line's card, under the toolbar (the palette and the land's
  lines are cards too, from the bar): its profile (click to go there), **Walk it**,
  **Reverse**, **Delete**, **Lay bed** (opens Shape with Along line in hand),
  and its fields. Ctrl-Z undoes; Save writes.

### Areas (Survey · Areas)

Woods, meadows and water, drawn on a map of your land over the operator's
hillshade. Pick a kind on the left. `D` draws (click corners, close on the
first; Shift-drag sketches), `B` paints with a round brush whose strokes become
one area, `V` edits (click an area, drag its corners; they snap to the other
areas and the land's edge; `Delete` erases it), `E` erases with a click.
Anything past your land is clipped off. On **Save**, two areas of the same
kind and class that overlap become one, and a newer area of another kind cuts
a hole in what it lies over: the save says so, "forest saved · merged with 1".
The right column is the selected area's fields. Ctrl-Z / Ctrl-Shift-Z and the
buttons under Save undo and redo.

### Kind defaults (Admin → Vocabulary)

Per kind: its width, whether it runs straight between nodes, the steepest it
should climb, and whether the pickers in Lines and Areas offer it at all
(db/0219). A blank field keeps the editors' own guess, shown as its
placeholder — so a blank width leaves each class its own.

### Catalog (`/app/catalog.html`)

Search, inspect and upload GLB models. An upload is canonicalised
(`canon-v1`: extensions stripped, Draco decoded, textures capped at 2048 px,
re-centred, deterministic bytes) and gets a SAN, the same one however it was
exported. Near-duplicates are flagged before upload (`similar_assets`).
Licences: `cc0`, `free`, `paid`, `limited` (editions); `buy_asset` is one
transaction with the edition count as its lock.

### Settings (admin)

**Setup** (account, GeoServer, ground, the bundled blocks and the checking
process server), **Vocabulary** (kinds and their properties), **Symbols**
(what a drawn thing becomes; **Apply to world** is what moves the world,
`docs/import.md`), **Ground cover** (class rasters mapped onto the
vocabulary).

### Editor (`/app/edit.html`)

The web GIS editor: OpenLayers over the world's features, drawing and editing
highways, land use, nature, buildings and terrain edits with property forms.
Writes go through PostgREST and row-level security; a writer's drawing is an
insert, an `edit` grantee's is a proposal. Drawing dirties the covering tiles.

### XR (`/app/play.html?xr=1`)

Lower budgets (8 M splats, 24 tiles), an **enter VR** button in Settings →
Setup, teleport locomotion by trigger. Not yet run on a headset; `docs/xr.md`
is the checklist.

### API (PostgREST)

Tables are read through `security_invoker` views; writes go only through RPCs.
Examples:

```sh
curl -X POST localhost:3000/rpc/register -H 'Content-Type: application/json' \
     -d '{"email":"me@example.com","pw":"password12"}'
TOKEN=$(curl -s -X POST localhost:3000/rpc/login -H 'Content-Type: application/json' \
     -d '{"email":"me@example.com","pw":"password12"}' | tr -d '"')
curl localhost:3000/tile?dirty=is.true                      # anyone
curl localhost:3000/progress                                # anyone
curl -X POST localhost:3000/rpc/ensure_job -H "Authorization: Bearer $TOKEN" \
     -H 'Content-Type: application/json' -d '{"z":14,"x":8552,"y":5737}'
```

RPCs: `register login ensure_job claim_atom heartbeat submit_atom
submit_verification publish_tile set_bounty pay register_artifact
register_asset similar_assets buy_asset transfer_asset_right propose approve
merge_proposal set_grant revoke_grant set_required_approvals area_grants
my_proposals my_dirty_tiles recheck_atom spot_due can_write save_flow
delete_flow save_height_edit qgis_credentials deploy_flow`, among others.
Row-level security decides every write; the client has no authority of its
own.

### Drawing (QGIS)

Land → **Shape this land in QGIS** hands you a project with your own
database login in it; QGIS edits `gis.f_*` and `gis.instance` directly, under
the same row-level security as the browser. `gis/README.md` has the details and
the committed project's pg_service entry. The `Tiles` layer shows compile state.

## 6. Verify an installation

```sh
make player-run   # the stories, through the page, from an empty database
make gate         # db-test, api-test, client-test, lint
```

`docs/gates.md` lists what each gate covers and when browser tests skip.
`make db-test` resets the database: do not run it against a live world.

## 7. Operations

`docs/runbook.md` is the on-call document. The short form:

- **Backup**: `bash tools/backup.sh /srv/backups` — `pg_dump` first, then
  rsync of `/assets` and `/tiles` hard-linked against the previous run. `/geo`
  is cut again on demand and `/jobs` is scratch; neither is backed up.
- **Restore**: `bash tools/restore.sh <backup-dir>` — files first, database
  second, so the database never names bytes the store lacks. `--check` reports
  drift without restoring. The restore drill runs on every `make api-test`.
- **Garbage collection**: `bash tools/gc-jobs.sh` (dry run) / `--apply` deletes
  `/jobs` output of jobs done for more than 7 days.
- **Rate limits**: nginx limits PUT to 20/s per address (burst 100, 429 over);
  the `splatworld` server does not.
- The file store is write-once; a second PUT to a path is 409. `make
  db-reset` empties the tables but not the store — the tools tolerate the 409s.
- Progress: `curl localhost:3000/progress`, or in SQL
  `SELECT state, count(*) FROM atom GROUP BY 1`.

## 8. Not done, or unrun

- Training at the operator's own sizes needs a real GPU; the gate's training
  specs skip on a software adapter (`client/test/e2e/worker.js` `NO_GPU`).
- WP5.4 needs a headset (`docs/xr.md`).
- No real process server has been reached from here; every flow story passed
  against `tools/elx-fixture.py` only (`docs/flow.md`).
- The player-run's OSM and swissTLM3D data are stand-ins where Overpass and
  swisstopo are unreachable (`infra/seed/README.md`).

## Shaping the ground in QGIS

The project the Land panel hands you carries a **Ground shaping (m)** raster
for every land there is: one float per cell, metres above or below what the
operator's elevation says is there, read from the world's own file
(`docs/rendering.md` §6) through a GeoTIFF view of it. It is a raster like any
other — open it, edit it with whatever raster-editing plugin you use.

Saving the project does not save a raster, so the shaping is sent back by a
script instead:

1. Download it from the world at `/qgis/save-ground.py` (served by the
   `splatworld` server).
2. In the QGIS Python console:

   ```python
   from save_ground import save
   save(iface.activeLayer(), "<the land's id>", "http://<the world>",
        "you@example.com", "<your password>")
   ```

It writes one immutable `.r32`, registers it, and calls `save_height_edit` —
exactly what the page's Shape panel does, as you. The world refuses a land that
is not yours in words, and the script prints what it said.

**Why a plain script and not a Processing algorithm**: headless QGIS runs a
plain script, which is what the player-run needs to prove this story
(`client/test/run/25-shape-in-qgis.spec.js`), and an algorithm would have been
a second thing to keep working for no gain. FND.10 left the choice open; this
is the choice.
