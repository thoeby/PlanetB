# TASKS-flows.md — F10: flows reach process servers, and objects carry flows

The task file `TASKS-foundation.md` promised under "After this file", widened by
what the owner asked for on 2026-09-24:

> connect to different servers; edit processes, jobs, services, blocks on
> them; add a process to an object.

Read in this order before touching anything:

1. `CLAUDE.md` — every invariant still holds. Invariant 9 decides the shape
   of all of this: **the world sends nothing out.** Every conversation with a
   process server is the player's own tab talking to it, and the process
   server talks back to the world as a login of its own, under RLS.
2. `PLAN-foundation.md` §0 D10–D12, §8, §10. **This file amends §8** in one
   place: the reference editor's REST client, services, jobs and reports
   panels *are* copied now ("Not copied" in §8 was for F1–F9).
3. `docs/flow.md` — what Automate is today and what is unproven.
4. The reference repo `wireon-process-editor` (read-only, at
   `../wireon-process-editor`): `docs/API-ENDPOINTS.md`,
   `docs/OPEN-QUESTIONS.md`, `docs/DECISIONS.md`, and `src/api/`,
   `src/services/`, `src/jobs/`, `src/ui/{servicelist,serviceeditor,joblist,jobeditor,reportlist,reportviewer}.js`.
   Code is copied from it, split to the 400-line rule, never imported.

Stories 1–31 stay green under every story here.

---

## How a process server is spoken to (summary of the reference)

- REST, every route under `/api/v1`. No auth (a local, trusted server in v1).
- Every response is an `<elx_api_msg type="response" version="1">` with
  `<data>` and `<error><code>`. **Code ≠ 0 with HTTP 200 is a failure.**
  Documents (ELX, reports) come entity-encoded in
  `<document><content>`; plugins as repeated `<descriptor>` children.
- Routes the tab uses:

| resource | routes |
|---|---|
| system | `GET /system/status` (reachability), `GET/PATCH /system/settings`, `GET /system/plugins/available` (the server's blocks) |
| process | `GET /process?limit&offset`, `GET /process/<id>/download?type=elx`, `GET /process/exists?name=`, `POST /process/validate`, `POST /process/duplicate`, `PUT /process` (create), `PATCH /process/<id>`, `DELETE /process/<id>` |
| service | `GET /service?limit&offset`, `GET /service/exists?name=`, `POST /service`, `PATCH/DELETE /service/<id>` |
| job | `GET /job?limit&offset`, `POST /job`, `GET/PATCH/DELETE /job/<id>`, `POST /job/<id>/run`, `POST /job/run`, `WS /job/run` |
| report | `GET /report?job_id&limit&offset`, `GET /report/<id>`, `DELETE /report?id=` |

- **Unconfirmed in the reference, and so here** (each gets one sentence in
  the UI when the server refuses, never a silent retry): write bodies for
  service / job / duplicate / settings (JSON sent, XML likely wanted);
  `PATCH/DELETE /service/<id>`; the trigger write path (inside the job
  body); the report list; the run WebSocket's frames. The first real server
  settles them — record the result in `docs/flow.md`'s table.
- **CORS** is the one thing that stops a page talking to a process server at
  all. The sentence for it already exists (FND.2) and is reused.

## The fixture

There is no process server in this container. `tools/elx-fixture.py`
(stdlib only, like `tools/geoserver-fixture.py`) answers the routes above in
the envelope, in memory, with CORS headers, and **accepts writes in both JSON
and XML** so it settles nothing about the open questions above. It is what a
player is *given* (PLAYER-RUN.md: "a running server"). The run starts two of
them on different ports, `alpha` and `beta`. A story that passed against the
fixture has passed against the fixture only; `docs/flow.md` gets a row per
story for the real server.

When a job's run is asked for, the fixture does what a process server does
with a World block: it calls the `world` URL it was given with the
`world_key` it was given (FL.7). It does not interpret any other block.

---

## Ground rules (in addition to CLAUDE.md and TASKS-foundation.md's)

- One story = one commit, `FL.<n>: <story title>`. Player-run story numbers
  continue at 32.
- Migrations continue after the highest number in `db/` at the time and are
  named as sentences.
- **This file approves** exactly the tables, columns and RPCs it names.
- Client code for talking to a process server lives in `client/flow/server/`
  (copied `endpoints.js`, `xml.js`, the envelope half of `rest.js`, split).
  `client/flow/validate.js` is folded into it; FND.2's behaviour is unchanged.
- Nothing the tab learns from a process server is stored in the world except
  what a story names (the server's address, a deployment row). Processes,
  jobs, services and reports stay on the process server.

---

## FL.1 — My process servers

A player keeps a list of process servers and switches between them in
Automate without reloading.

- Table `process_server`: `id`, `owner` (user), `name` (1–40, unique per
  owner), `url` (http/https, no path beyond `/`), `created_at`,
  `deleted_at`. RLS: the owner reads and writes their own rows; nobody else
  sees them (an address can say where somebody's machine is).
- RPCs `save_process_server(id, name, url)`, `delete_process_server(id)`.
- The operator's `elx_url` (db/0156) shows in every player's list as
  **World's server**, read-only, first.
- Automate top bar: **Server** dropdown (World's server · mine · *Add…*),
  a status dot from `GET /system/status` polled every 15 s while Automate is
  open, and the server's version when it reports one. *Add…* asks name + URL,
  **Test** probes before **Save**. Choosing another server switches every
  panel below to it with no reload; the choice is remembered per tab
  (`localStorage`, try/catch).
- Refusals: "That address did not answer." · "It answered, but this page is
  not allowed to read it (CORS) — the server has to allow <origin>." ·
  "You already have a server called <name>."

**Story 32**: B adds `alpha` and `beta`, sees both green; stops `beta`, sees
it red with the sentence; switches to `alpha`; reloads; `alpha` is still
chosen. C does not see B's servers.

## FL.2 — Blocks come from the chosen server

- With a server chosen, the palette is the bundled plugins **plus** what
  `GET /system/plugins/available` returns, parsed by the existing
  `client/flow/plugins/parse.js`. A plugin both have: the server's wins, and
  the palette group says "from <server>".
- A block in the open flow that the chosen server does not have is drawn
  hatched (existing FND.1 drawing), with "<server> has no <plugin>" — the
  flow is still saved into the world exactly as it is.
- Palette header: **Refresh blocks**.
- World blocks: if the chosen server lists `world`, the group says so —
  this is FND.14's branch A answered, written into `docs/flow.md`.

**Story 33**: `alpha` offers a plugin the bundle lacks; B finds its block by
search, puts it into a flow, saves; switches to `beta` (which lacks it) and sees it
hatched with the sentence.

## FL.3 — Processes on a server

Automate's left column gets a second tab, **On <server>**, beside *My flows*.

- **Processes**: list (paged), open (read-only canvas, "on <server>"),
  **Save into my land…** (land picker → a normal `flow` row; bytes as
  downloaded — the FND.2 rule that an import keeps its bytes),
  **Duplicate**, **Rename**, **Delete** ("Delete process <name> on
  <server>? Jobs that run it stop working.").
- A world flow gets **Send to <server>**: `exists` → `PUT /process`, or
  `PATCH /process/<id>` when this flow was sent there before (FL.6's row);
  "<server> already has a process called <name>" offers Replace / Rename.
- Validate (FND.2) asks the **chosen** server, not only `elx_url`.

**Story 34**: B sends story 33's flow *Weather check* to `alpha`; sees it
listed there; opens it read-only; duplicates it and deletes the copy; sends
it again and is asked before anything is sent over; saves `alpha`'s
*file-response* sample into land B as a flow; exports it — byte-identical to
what `alpha` returned. A new process's name travels as `?name=` (the reference
has nowhere to put one; recorded in `docs/flow.md`).

## FL.4 — Services on a server

Copied from the reference `servicelist.js` / `serviceeditor.js` /
`services/params.js`, split.

- **Services** list; **New** (type from the chosen server's plugins'
  `<services>` — `plugin::component`), parameter form from the plugin
  schema, `exists` before save; **Edit**, **Delete**.
- A server that refuses `PATCH/DELETE /service/<id>` gets: "<server> does
  not let this page change a service yet — its address for one service is
  missing." (reference OPEN-QUESTIONS § per-record route).

**Story 35**: B creates `http::server` on port 8082 on `alpha`, edits the
port, sees the change after reload, deletes it.

## FL.5 — Jobs and reports on a server

Copied from the reference `joblist.js` / `jobeditor.js` / `jobs/cron.js` /
`reportlist.js` / `reportviewer.js`, split.

- **Jobs**: list, New / Edit / Delete: name, process (dropdown of the
  server's processes), log level, store report, input values, triggers
  (cron with "next 5", http, filesystem, mqtt — services by dropdown).
  "A cron trigger checks at most once a minute." stays under the cron field
  (PLAN §8).
- **Run now** on a job row → `POST /job/<id>/run`; live output in the bottom
  log panel over `WS /job/run` when the server has it, the job's report when
  it does not.
- **Reports**: list per job, viewer as a collapsible tree, delete.
- The world stores none of this.

**Story 36**: B makes job *Dusk* on `alpha` for *Weather check* with a cron
trigger, sees the next five firings, runs it now, reads its report.

## FL.6 — A flow belongs to an object

*Add a process to an object.* A flow may belong to one placed thing on its
land; the thing's panel lists its flows.

- Column `flow.instance_id uuid NULL REFERENCES instance (id)`; `save_flow`
  gains `p_instance` **as a new overload** — the existing signature keeps
  working (CLAUDE.md "ask before changing an RPC signature"). Refused unless
  the instance stands on the flow's land: "<thing> is not on <land>."
  A deleted instance leaves its flows on the land, unattached, and the flow
  list says "was on <thing>".
- Build panel, a selected object: section **Flows** — its flows by name,
  **Open** (Automate, that flow), **Add flow** (new flow on this land,
  attached, with *World clock* and *Write port* already pointed at this
  object), **Attach existing…** (the land's unattached flows), **Detach**.
  Who may: whoever may build on the land (as `may_write_port`). Others see
  the list and nothing to press; approvers see it too (FND.1's read rule).
- Automate's *My flows* groups land → object → flow; unattached flows under
  the land.
- World blocks in a flow that belongs to an object default to that object in
  their World section (FND.14's picker still overrides).

**Story 37**: B selects the lamp from story 30, **Add flow**, names it *Lamp
at dusk*, finds *Write port* already on the lamp's `on`, ticks the value,
saves; back in the world the lamp's panel lists it; C (build grant) opens it
from the lamp; D, who does not build there, is told why there is nothing to
press (the flow itself is not readable to D — db/0155's rule); B detaches it
and attaches it again with **Attach existing…**.

## FL.7 — Running an object's flow on a server

The piece F10 was named for, for a player's **own** server. The pool of
other people's servers (D12: leases, restarts, price per hour) is FL.8.

- Table `flow_deployment`: `id`, `flow_id`, `server_id`
  (`process_server`), `elx_sha256` (what was sent), `remote_process_id`,
  `remote_job_id`, `key_jti`, `created_by`, `created_at`, `revoked_at`.
  RLS as `flow`. One live row per (flow, server).
- A flow login: role `flow`, a JWT signed by `auth.sign` with `flow_id`,
  `area_id`, `jti`, `exp` (30 days), issued by
  `deploy_flow(flow, server, elx_sha256, process, job)` to whoever may build
  on the land — the page makes the process and the job on the server first,
  then writes the key into the job's `world_key` — returned **once**, never stored (only
  its `jti`). `revoke_flow_key(deployment)`.
- `port_write` and `world_clock` accept role `flow` — `port_write` **for
  things on that flow's land only**, only while its `jti` is not revoked and
  whoever issued it still builds there. A World block writes its value as the
  ELX carries it, in words (`"true"`), so `port_write` reads a word as the
  port's own kind (`port_value_of`). A write is recorded as written by the
  player who issued the key (`live_state.written_by` is a user; not changed).
  `mover_set` and `world_events` for a flow: see Blocked.
- **Run on <server>** (object panel and Automate top bar): sends the ELX
  (FL.3), creates or updates a job with `world` = this world's public URL
  and `world_key` = the new key, trigger chosen in the dialog (manual / cron
  / world event poll), and saves the `flow_deployment` row. **Stop** deletes
  the job, revokes the key, keeps the process.
- The object panel shows, per flow: where it runs, "sent <rev> — the flow
  has changed since" when `elx_sha256` differs, and the last report's
  result when the server answers.

**Story 38**: B switches the lamp off by hand, then runs *Lamp at dusk* on
`alpha` from the lamp's panel, "Now, once"; the fixture runs the job with the
key; A, standing by the lamp, sees it go on within 10 s (story 30's check); B
stops it (asked first, design 10l); a run the fixture makes anyway with the
old key is refused and the lamp stays as B left it. That a flow key cannot
write a port on another land is db/test/0197's.

## FL.8 — The Planner

The operator's sketch (`docs/design/assets/planner-sketch.png`): every job on
the chosen server as a lane on a timeline — what ran when, how it ended, how
long it took, and what runs next.

- **Planner** on the Jobs section opens it over Automate. Top: the job count
  on the server, what the server last said, **New job**, **Refresh**, **Close**.
  Tools: the day (‹ › and **Now**), the window (6 h · 24 h · 7 days), **All
  runs** · **Failed only**, and the legend.
- A lane a job: its name, process and triggers; its runs from the server's
  reports, placed at their time and as wide as they took; its planned runs
  (the cron evaluator's reading of its triggers, dashed — the server is the
  authority); the line that is now; on the right its next run and "N runs ·
  M failed · usually X".
- A run opened: when, how long, what started it, how it ended, and for a
  failure the first thing its report says went wrong; **Open report**, **Run
  now**, **Edit job**.
- The chosen job underneath: how long each of its last 60 runs took, the
  usual run (the median) dashed, slowest and failed counted, a tooltip a bar.
- Status is never colour alone: done solid, warnings hatched, failed outlined
  and crossed, running dashed, skipped grey hatched, planned a dashed tick;
  the legend names each.
- A report's duration, what started it and its warnings are read as
  `duration_ms`, `started_by` and `warnings` — assumed like the rest of the
  report row (`docs/flow.md`); without them a run is a tick and says "—".

**Story 39**: B makes *Broken* on `alpha` (story 38's process, no world
address), runs it, and runs *Dusk* twice more. The Planner shows two lanes:
Dusk's three runs done and its next at 18:00, Broken's run failed; opened, it
says what alpha said. Choosing Dusk draws its three run times. Failed only
leaves the failure; Run now from its card runs it again; 7 days shows a tick
a day.

## FL.9 — The pool (D12)

Other people's servers take flows for a price per hour. Written as its own
task file when FL.8 is green: a `process_server` row marked *offered*,
`flow_run` leases with heartbeat, a dropped run restarts fresh on the next
runner (a flow never resumes), the owner sees every restart, price per hour
through the ledger (Invariant 5), Work → Flow runs. Not started here.

---

## Blocked

- **Stories 32–38 are green on a world built from stories 0, 1, 2, 4, 5, 10,
  20, 21 and 30** (saved and replayed with `tools/replay.sh`), the way
  FND.14–16 were proven, not through a whole run from an empty database:
  story 8 renders for most of an hour here, and two stories before these
  fail on the branch as it was found — the next two items.
- **Story 29 then story 30 in one run fails at 30** (found before any F10
  change): 29 leaves a lamp where 30 clicks to place one, so the click picks
  29's lamp up and 30's Save has nothing to save. FND.14–16 were each run
  from the same saved world, never in sequence.
- **Story 2 asserted exactly one unsubmitted tile.** In this container the
  boundary A draws crosses a z14 edge and the land has two. The assertion now
  reads "one or more"; the count is the map's scale, not the story's.
- **db/test/0179 and db/test/0186 fail without any F10 migration** (checked
  on a database migrated to db/0192 only): they assert the pool and the seed
  grid as they stood before the last commits on the branch (`5f5e272` and
  before). Not touched here.
- **`mover_set` and `world_events` do not accept a flow key yet.** `mover_set`
  asks `is_area_writer(area)` of the caller, and with a flow key the caller
  is the player who issued it, on every land they write — granting it to
  `flow` would let the key move buses on the issuer's other lands. It needs
  the land check `may_write_port` got, inside `mover_set`; `world_events`
  still refuses everybody (F10's runner). Both are for the task after this.
- **No real process server has been reached from this container**, so every
  story above is proven against `tools/elx-fixture.py` only. The open wire
  questions (write bodies, service per-record route, trigger path, report
  list, WS frames) stay open until one is; the fixture accepts both shapes
  so as not to pretend otherwise.
