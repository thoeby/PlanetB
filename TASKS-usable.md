# TASKS-usable.md — make splatworld usable

Read this before `CLAUDE.md`. Where they disagree, this wins.

## The concept (binding)

One world on the real DEM. No imagery, no OSM, no real roads or cities. Real
ground, empty. Where there is DEM there is world; nowhere else.

People own land (`area`). The owner shapes his land in QGIS over GeoServer:
roads, forests, water, single trees, terrain. We do not build a GIS editor and
do not replace those tools.

Building is done with products from the catalog. Anyone can register a product
(a wall, a stone, a house); listing rules come later. Building happens in the
editor: it shows the world, lets you place catalog products on your own land,
and submit. Placement is an `instance`. The editor does not model and does not
edit land.

Submitting puts the affected tiles into a public render pool. Anyone can render
them and is paid; the submitter pays, or renders himself. A rendered tile is a
candidate. A person with authority approves it; then it is published. Approval
is a person, not a check.

Properties on land, features and products are defined by admins in the tool, not
in code. OSM tags are the reference vocabulary.

Nothing above is a "system". People, responsibilities, consequences.

## The bar

A task is done when a person who has never seen the repo does the acceptance
line in the browser or QGIS, with no shell, no doc, no hint. `make gate` is
necessary, not sufficient. If it needs a doc to be found, it is not done.

## Rules for the agent

- No new pages. Everything reachable from `play.html` and the QGIS project.
- No ADRs, plans, specs, progress notes. Code and the acceptance line.
- No schema in code: no kind lists, property names, species, roof types in JS or
  SQL constants. They come from tables admins edit (T3).
- Remove what the concept excludes when you touch it: ortho draping, OSM
  seeding, Sentinel tooling, trust-score publish gate. Keep hash checks on
  deterministic tiles (invisible plumbing). Keep `build_rule` — it is how a
  forest type becomes trees; do not extend it now.
- `edit.html` stays for now; it is not the answer to anything in this file.

## T0 — Install and see ground

Delivered: `pip install -e ./server`, `splatworld run`, browser opens. Setup
page: account, GeoServer address + login, pick the DEM coverage from what
GeoServer lists. Press Done → viewer opens over that DEM.

Acceptance: fresh machine with GeoServer holding a DEM. Ten minutes, no terminal
beyond the two commands, standing on real ground in the viewer.

Removes: ortho from the compile path (terrain coloured by height/slope until
ground types exist), `MAX_TILES`, whole-coverage WCS fetch, Copernicus mosaic as
the elevation path, `seed-dem/ortho/osm`.

## T1 — Ground per tile from GeoServer

Delivered: `/geo/dem/{z}/{x}/{y}` is served on demand: on a miss the server asks
GeoServer WCS for that tile's bbox at 256², encodes `dem-v1`, stores it
immutable, registers the artifact, pins its sha into the job that asked. The
playable extent is the coverage's extent; outside it the viewer says so.

Acceptance: a DEM of any size in GeoServer. Walk anywhere it covers; ground
appears without any pre-step. Change the coverage on the setup page → tiles
under it recompile.

## T2 — Land in QGIS

Delivered: `gis/splatworld.qgs` in the repo (XML, hand-authored, committed):
area, road, forest, water, terrainmod, tree-point, instance, tile-state layers
over WFS-T; DEM hillshade from the same GeoServer. Forms on every layer show the
properties from T3, with dropdowns where values are defined. Model on tree-point
/ instance picked from a catalog dropdown (name + SAN).

Acceptance: open the project, draw an area, a road, a forest, place one tree
with a model, save. Rows through PostgREST; tiles marked. Done on a real QGIS
against a real GeoServer, and the WP0.11 checklist ticked on that run.

## T3 — Properties defined in the tool

Delivered: admin panel in the editor: for each layer kind and for products,
define properties (name, type, allowed values, required). Stored in tables;
published through GeoServer so QGIS forms show them; the editor's forms and the
compiler read the same tables. Ship a starter set modelled on OSM tags
(`highway`, `natural=wood` + `leaf_type`, `building` + `height`, …).

Acceptance: admin adds property `leaf_type` with values needleleaved /
broadleaved. Without reload, QGIS forest form offers it; a forest saved with it
compiles with `build_rule` matching on it.

## T4 — Catalog

Delivered: register a product from the editor: upload GLB, name, properties from
T3, licence. Listed immediately to the registrant; visibility rules are a later
task. Search, thumbnail, detail.

Acceptance: upload a house GLB, find it by name in the editor's picker two
seconds later.

## T5 — Editor: place products on your land

Delivered: one page (`play.html`): 3D view; your areas outlined; a panel listing
your areas, and inside one, what you placed. Pick a product from the picker,
click the ground, adjust move/rotate/scale/height, delete. Only inside your own
area. Everything else read-only. Every control visible; no key you have to know.

Acceptance: a stranger with an area places the house from T4 in front of the
tree from T2 in under two minutes, without being told any key.

## T6 — Submit and the render pool

Delivered: Submit on the area. Affected tiles enter the public pool with the
price the submitter attaches (or zero and "render myself"). Any viewer shows the
pool: tiles, price, distance; Render claims and runs in this tab, pays on
completion. Progress per area visible to the owner. Finest tiles first, parents
follow automatically.

Acceptance: A submits with 10 coins. B opens the pool, renders it, has 10 coins.
A sees the tile as candidate.

Builds on: `ensure_job`, `set_bounty`, `claim_atom`, escrow release. Removes: the
per-tile "render" list and the trust-gated verify atoms as the publish gate.

## T7 — Permission

Delivered: candidates are visible to their owner and to approvers, in place,
with a switch published/candidate. Approve → published for everyone. Refuse →
note to the owner, tile stays as it was. Who approves what: the area owner for
his own land, plus a grant `approve` on an area (exists).

Acceptance: B's candidate from T6; A (owner) sees it, approves, C sees the
house.

## T8 — Visit

Delivered: URL carries position; Copy link in the editor and as a QGIS action on
area. Opening it places you there.

Acceptance: A sends a link, C opens it on another machine and stands in front of
the house.

## T9 — Nothing "you have to know"

Delivered: from `play.html` every function above is reachable by a visible
control with a label. Setup, catalog, admin properties, areas, pool, wallet are
panels of it. Old pages redirect there.

Acceptance: a stranger lists, without help, everything the tool can do, from
what is on screen.

Not before T9 is done: CI, XR, ops, country seed, visibility rules, selling
land, forest species.
