# PLAYER-RUN.md — the only task until it is green

This replaces TASKS.md, TASKS-usable.md and the WP lists as the thing an agent
works on. Read `docs/SPEC.md` §3 for the stories; this file says how they are
proven and in what order they are built.

## The rule

Nothing is done because a function exists, a panel renders, or a unit test
passes. A story is done when **a script that behaves like a player** completes
it through the page and through QGIS, with no SQL, no CLI, no fixture row
inserted by hand at any step a player would take. The script is the player.
If it can't find a button, the button is missing. If it can't tell what
happened, the feedback is missing. Build what the script needs; touch nothing
else.

The operator opens a build only when every story in §4 of this file passes on
the same machine, in one run, from an empty database. Until then no build is
handed over, no "try this", no bug reports from a human.

## Ground rules for the agent

- One story at a time, in the order below. A story is not started until the
  previous one is green on the same run.
- No fixture may do what the story's player would do. Fixtures may only
  provide what the player is *given*: a running server, a GeoServer with a
  DEM, a GLB file on disk, a second player's account.
- No migration in this work corrects a migration written earlier in this
  work. Revert instead.
- No new panel, page, or CLI command unless a story step needs it to pass.
- Do not edit the spec to make a story easier. If a spec step is impossible
  as written, write one sentence under "Blocked" in this file and stop.
- Existing e2e specs (`client/test/e2e/*.spec.js`) stay and stay green; they
  test parts. The player-run tests the whole. When they disagree, the
  player-run wins and the part test is fixed.

## The harness (build this first, before story 1)

`client/test/run/` — a Playwright project separate from `e2e`, run by
`make player-run`.

- **World.** Starts from `make db-reset` and a fresh `infra/files`. The
  Python server (`splatworld run`) and PostgREST on their ports. A GeoServer
  container from `infra/compose.yml` with a coverage store over
  `infra/seed/dem-visp.tif` — a real 4 × 4 km DEM cutout around Visp
  (Copernicus GLO-30 tiles; `tools/make-seed-dem.sh` fetches and clips it
  once and caches it). No ground is pre-cut; story 1 must cut it through
  the normal path.
- **Players.** Three browser contexts: A (first player, becomes admin), B,
  C. Each has only the page. They act by visible controls: `getByRole`,
  `getByLabel`, `getByText`. No `page.evaluate` into app state, no direct
  RPC. A step that needs a keyboard key uses it only if the page shows the
  key on screen.
- **QGIS.** Headless QGIS (`qgis_process` / PyQGIS in the
  `qgis/qgis:release` image). It opens the project the page downloaded for
  the player and performs edits through the layers exactly as a user would:
  open layer, start editing, add feature with attributes, commit. Errors are
  read from the provider's commit result, as QGIS would show them.
- **Rendering.** Chromium with WebGPU where the runner has a GPU; otherwise
  the software trainer path, which must produce a publishable tile even if it
  looks bad. The story asserts publish and visibility, not picture quality.
- **What is seen.** Every step asserts what is on screen: the sentence in
  the panel, the label on the tile, the model in the 3D view (a screenshot
  region diff against the previous state, at the spot). Row counts are
  allowed only in addition, never instead.
- **Time.** A player waits; the script waits the same way: on the visible
  state changing, with a ceiling per step (30 s UI, 10 min render). No
  sleeps.
- **Report.** On failure: the story, the step, the sentence the script
  expected, the screenshot, the page's console. That report is the whole
  bug description; nothing else needs writing.

## Stories, in build order (from SPEC.md §3)

Each line is what the script does; the acceptance is the spec's story.

1. **First run** (3.1). A opens the page over an empty world. Sign up, name,
   GeoServer address, pick the coverage, done. A stands on ground at the
   coverage centre; the position line says "unclaimed ground"; A can walk
   50 m and the ground follows. *Requires the DEM to be the floor in the
   viewer.* This story is where that gets built.
2. **Getting land** (3.2). B signs up, requests land with a note. A sees the
   request, assigns land by drawing it on the map in the page, names it. B
   is notified, presses Go, stands on it, the boundary and name are drawn on
   the ground. Land with wrong coordinates is impossible to create: the
   script tries the swap and reads the sentence.
3. **Shaping land in QGIS** (3.3). B downloads the project from the Land
   panel, QGIS opens it, draws a forest with a type, places a tree with a
   model chosen by name, saves. B's page shows "1 tile changed" within 30 s.
   Drawing outside B's land is refused with a sentence QGIS shows.
4. **Registering a product** (3.9). C drops a GLB, sees its size, names it,
   registers. B finds it in the picker by name.
5. **Building** (3.4). B enters Build on his land (the page told him the
   key), picks C's product, places it, moves it, saves. C standing there
   sees the model marked unrendered within 30 s. B undoes one, saves, C sees
   one. B off his land: the Build control says why it is disabled.
6. **Submitting** (3.5). B submits; the dialog listed what changed; the
   tile says "awaiting approval".
7. **Approving** (3.6). B (owner) sees it waiting, reviews in place with
   Before/After, approves. The tile says "queued". Refuse branch: B refuses
   with a note; the note is on the object.
8. **Rendering** (3.7). C opens Render, takes the job at price 0, watches
   progress on the tile, it publishes. A, elsewhere, sees the splats at the
   spot. The coarse rebuild job appears and C takes it too.
9. **Visiting** (3.8). B copies a link; A opens it in a fresh context and
   stands there facing the same way.
10. **Grants** (3.11). C asks B for a build grant from B's land; B gives it;
    C builds; B submits and approves; C's object is attributed to C.
11. **Deleting and redoing land.** B deletes his land from the Land panel
    (objects and features go with it, with a confirmation that says what
    goes); the tiles return to ground; B requests land again and story 2
    repeats. *This is the step the operator could not do today.*
12. **Properties** (3.10). A adds a property to "forest" with two choices.
    B's page shows the project-out-of-date notice; B downloads again; QGIS
    shows the dropdown; B draws with it; the compile uses it.
13. **Failure and recovery** (3.12). The GeoServer is stopped mid-run: the
    page says so in place and keeps working; restarted: ground resumes. A
    render job is abandoned: it returns to the pool with the sentence.

## Work already known, and which story it belongs to

The stories force these; they are not optional and not to be done "later".
Each is done inside its story, and the story is the proof.

| story | known work | how |
|---|---|---|
| 1 | The viewer draws and walks on the DEM (`/geo/dem` tiles) everywhere the coverage reaches; published splats sit on top. Today `player.js:140 heightAt` only knows published tiles, so a fresh world has no floor and you spawn under the terrain. | new `client/lib/groundmesh.js` streamed like tiles; `Terrain.heightAt` falls back to it; `build.js raycastGround` uses it. |
| 2 | Land or features outside the ground are refused with a sentence; a polygon whose axes are swapped gets the sentence that says so. Today a polygon off Ethiopia is stored happily and fails hours later as "outside the world's coverage". | `REFACTOR-direct-pg.md` S1. |
| 3 | QGIS edits the database directly as the player, under RLS. GeoServer serves rasters only. Removes `gsprovision.py`, the `geoserver` DB role, WFS-T, `gt_pk_metadata`, and the whole class of axis-order and read-only-layer failures. The project is downloaded from the Land panel with the player's own credentials. | `REFACTOR-direct-pg.md` S2–S5, in that order, each its own commit, smoke after each. Story 3 is green only on the direct connection; a WFS pass does not count. |
| 3 | `splatworld import` no longer fetches elevation (`importer.py:310`); ground comes from story 1's path. | `REFACTOR-direct-pg.md` S6. |
| 8 | A merge job is neither listed nor claimable before its children are published; failed jobs go back to the pool by themselves; the pool labels a z14 tile "assembled", not "merged from its children". Today `submit_area` opens the whole ladder at once and three guards (0035, 0044, 0050) still let a merge through. | `REFACTOR-direct-pg.md` S7; `poolui.js` label. |
| 8 | A tab without a hardware GPU says so next to the job instead of failing on it (commit c2c92c2 detects it; the pool doesn't show it). | `poolui.js`: "what this needs / what this tab has". |
| 11 | Delete land from the page. `delete_area` exists (0038:99) and nothing calls it. | Land panel: Delete with a confirmation naming what goes. |
| all | Every atom or API error reaches the screen as a sentence on the thing that failed. No state is only in the console or a log. | `hud.say` / tile label / land card. |

## Blocked

(Agent writes here, one sentence per item, and stops.)

## Done means

`make player-run` from an empty database, stories 1–13 green, on the
operator's machine and in CI. Then, and only then, the operator opens the
page.
