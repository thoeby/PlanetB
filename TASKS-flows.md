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
search, wires it, saves; switches to `beta` (which lacks it) and sees it
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

**Story 34**: B sends flow *Lamp at dusk* to `alpha`; sees it listed there;
opens it read-only; duplicates it as *Lamp copy*; deletes the copy; saves
`alpha`'s *file-response* sample into land B as a flow; exports it —
byte-identical to what `alpha` returned.

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

**Story 36**: B makes job *Dusk* on `alpha` for *Lamp at dusk* with a cron
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
at dusk*, finds *Write port* already on the lamp's `on`, saves; back in the
world the lamp's panel lists it; C (build grant) sees and opens it; a player
without a grant sees the list and no buttons; B detaches it and it shows
under the land.

## FL.7 — Running an object's flow on a server

The piece F10 was named for, for a player's **own** server. The pool of
other people's servers (D12: leases, restarts, price per hour) is FL.8.

- Table `flow_deployment`: `id`, `flow_id`, `server_id`
  (`process_server`), `elx_sha256` (what was sent), `remote_process_id`,
  `remote_job_id`, `key_jti`, `created_by`, `created_at`, `revoked_at`.
  RLS as `flow`. One live row per (flow, server).
- A flow login: role `flow`, a JWT signed by `auth.sign` with `flow_id`,
  `area_id`, `jti`, `exp` (30 days), issued by `deploy_flow(flow, server)`
  to whoever may build on the land, returned **once**, never stored (only
  its `jti`). `revoke_flow_key(deployment)`.
- `port_write`, `mover_set`, `world_events` accept role `flow` **for things
  on that flow's land only**, and only while its `jti` is not revoked. This
  lifts FND.14's "flows do not run yet" for them; `world_clock` is
  unchanged. Every write records `written_by` = the flow.
- **Run on <server>** (object panel and Automate top bar): sends the ELX
  (FL.3), creates or updates a job with `world` = this world's public URL
  and `world_key` = the new key, trigger chosen in the dialog (manual / cron
  / world event poll), and saves the `flow_deployment` row. **Stop** deletes
  the job, revokes the key, keeps the process.
- The object panel shows, per flow: where it runs, "sent <rev> — the flow
  has changed since" when `elx_sha256` differs, and the last report's
  result when the server answers.

**Story 38**: B runs *Lamp at dusk* on `alpha` from the lamp's panel; the
fixture runs the job; a second player sees the lamp switch within 5 s
(story 30's check); B stops it; the fixture's next run is refused ("this
flow's key was withdrawn") and the lamp stays as it is. A flow key cannot
write a port on land C.

## FL.8 — The pool (D12)

Other people's servers take flows for a price per hour. Written as its own
task file when FL.7 is green: a `process_server` row marked *offered*,
`flow_run` leases with heartbeat, a dropped run restarts fresh on the next
runner (a flow never resumes), the owner sees every restart, price per hour
through the ledger (Invariant 5), Work → Flow runs. Not started here.

---

## Blocked

- **No real process server has been reached from this container**, so every
  story above is proven against `tools/elx-fixture.py` only. The open wire
  questions (write bodies, service per-record route, trigger path, report
  list, WS frames) stay open until one is; the fixture accepts both shapes
  so as not to pretend otherwise.
