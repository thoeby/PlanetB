# F10 — screens and functions for the designer

What `TASKS-flows.md` (FL.1–FL.7) puts in front of a player, screen by screen:
every control, what it does, every state it can be in, and the exact sentences.
Written so a designer can draw the artboards while the stories are built. The
build uses the existing Automate styles (`client/hud.css`, `#flows`, `.fl-*`)
until an artboard replaces them; nothing here fixes a look, only the content.

Hue: Automate's own (the strip's Automate glyph). A process server is always
named by the name the player gave it; "World's server" is the operator's.

---

## 0. Where everything sits

```
┌ Automate top bar ───────────────────────────────────────────────────────────┐
│ Flows · Undo Redo Auto-layout · [Server ▾ ● alpha 1.4]   unsaved · said …   │
│                               Save Validate Send Run Export Import Close   │
├ left ──────────────┬ centre ───────────────────────────┬ right ─────────────┤
│ [My flows|On alpha]│ canvas (unchanged)                 │ inspector          │
│  My flows:         │                                    │ (unchanged, plus   │
│   land → object →  │                                    │  "on alpha" note   │
│   flow             │                                    │  for server-only   │
│  On alpha:         │                                    │  processes)        │
│   Processes        │                                    │                    │
│   Services         │                                    │                    │
│   Jobs             │                                    │                    │
│   Reports          │                                    │                    │
├────────────────────┴───── bottom log panel (FL.5, only while running) ─────┤
```

And in the world: **Build → Place panel → selected object → Flows** section
(FL.6/FL.7), under the existing Ports section.

---

## 1. Server picker (top bar) — FL.1

| element | content / behaviour |
|---|---|
| Dropdown `Server` | Rows: **World's server** (operator's `elx_url`, read-only, first; absent if not set) · the player's servers by name · divider · **Add a server…** · **Manage servers…** |
| Status dot | green = answered `/system/status` in the last 15 s; red = did not; grey = checking. Polled every 15 s while Automate is open. |
| Version | small text after the name when the server reports one |
| Tooltip on red | the sentence (below) |

Choosing a row switches every server panel at once, no reload. Remembered per
browser.

### 1a. Add / edit a server (dialog)

Fields: **Name** (1–40), **Address** (`http://host:port`). Buttons: **Test**,
**Save**, **Cancel**. After Test, one line under the address:

- ● "Answered — elx <version>."
- ● "That address did not answer."
- ● "It answered, but this page is not allowed to read it (CORS) — the server has to allow <origin>."

Save refusals (under the field that caused them):
- "You already have a server called <name>."
- "A server address starts with http:// or https://."
- "A server needs a name."

### 1b. Manage servers (dialog)

List: name · address · dot · **Edit** · **Remove** ("Remove <name>? Flows sent
there keep running there; this page just stops showing them." — only when FL.7
has none running there, else "<name> runs <n> of your flows — stop them first.").

Functions: `save_process_server(id,name,url)`, `delete_process_server(id)`,
select `process_server`, `app_settings()` for World's server,
`GET <url>/api/v1/system/status`.

---

## 2. Palette with a server's blocks — FL.2

| element | content |
|---|---|
| Palette header | search · **Refresh blocks** (icon button, tooltip "Ask <server> for its blocks again") |
| Group label | as today; a group the server supplied or overrode says "from <server>" |
| World group | "World — <server> knows these blocks" when it lists `world`; otherwise unchanged |
| Hatched block on canvas | existing FND.1 drawing; its label: "<server> has no <plugin>" |

States: loading ("asking <server> for its blocks…"), failed (the FL.1
sentence; bundled blocks remain).

Functions: `GET /system/plugins/available`.

---

## 3. "On <server>" tab (left column) — FL.3/4/5

Tab header: **My flows** | **On <server>**. The second tab is disabled with
"Choose a server first" when none is chosen. Inside: four collapsible sections.
Each list: paged (25), a **Refresh**, an empty state, an error line.

### 3a. Processes — FL.3

Row: name · (group, muted) · actions **Open** · **Save into my land…** ·
**Dup** · **Ren** · **Del**.

| action | result |
|---|---|
| Open | canvas shows it read-only; top bar name "<name> · on <server>"; Save is replaced by **Save into my land…** |
| Save into my land… | dialog: land picker + name → becomes a normal flow (bytes unchanged) |
| Dup | dialog, default "Copy of <name>" |
| Ren | dialog |
| Del | "Delete process <name> on <server>? Jobs that run it stop working." — type the name |

Empty: "<server> has no processes yet." Error: the FL.1 sentences, or the
server's own message after "<server> said: ".

### 3b. Services — FL.4

Row: name · `plugin::component` (muted) · **Edit** · **Del**. Header: **New service**.

**Service dialog** (two steps, like the reference editor):
1. Type — list of `plugin::component` from the server's plugins, with the
   plugin's description.
2. Parameters — one field per parameter of that type (text, number, switch,
   choice, file path, secret as password field), with defaults and
   descriptions; **Name** on top. Buttons **Save** / **Back** / **Cancel**.

Sentences: "<server> already has a service called <name>." ·
"<server> does not let this page change a service yet — its address for one service is missing." ·
Del: "Delete service <name> on <server>? Jobs and triggers that use it stop working."

### 3c. Jobs — FL.5

Row: name · process name · trigger summary ("cron 0 18 * * *", "http GET /x",
"manual") · **Run now** · **Edit** · **Del**. Header: **New job**.

**Job dialog** (tabs or stacked sections):
- *Job*: name, group, process (dropdown of the server's processes), log level
  (info · debug · warn · error), store report (never · on error · always).
- *Inputs*: one typed editor per process input. `world` and `world_key` are
  shown as "set by Run on…" and read-only when the job was made by FL.7.
- *Triggers*: list + **Add trigger** (cron · http · filesystem · mqtt).
  - cron: expression, "next 5 firings" list under it, and the fixed line
    "A cron trigger checks at most once a minute."
  - http: method, target path, request input, captures input, response
    output, service (dropdown of `http::server` services).
  - filesystem: path, recursive switch, action input.
  - mqtt: service (dropdown of `mqtt::client`), topic, topic input, payload input.
- Buttons **Save** / **Cancel**. Invalid cron: "That is not a cron expression — five fields, minute first."

### 3d. Run output (bottom panel) — FL.5

Opened by **Run now**. Header: job name · state (running · done · failed ·
result code) · level filter (all · info · warn · error) · **Close**.
Body: time · level · block · message, newest at the bottom. Nodes on the
canvas get small status badges while the flow is open. When the server has no
live stream: "<server> does not stream runs — its report is below." and the
report tree.

### 3e. Reports — FL.5

Filter: job dropdown (all). Row: time · job · result (✓ 0 / ✕ code) · **Open** ·
**Del**. **Report viewer**: collapsible XML tree, header with job, time, result.

---

## 4. My flows, grouped by object — FL.6

```
▾ Land B
   ▾ Street lamp 2          ← object (click: fly to it)
       Lamp at dusk   [● alpha]  Ren Dup Del
     Flows without a thing
       Morning report          Ren Dup Del
       Old sign (was on Sign 1)
```

- Object row: the object's name as the flow editor names it ("Street lamp 2").
- Flow row gets a small **where it runs** chip from FL.7: "● alpha", or
  "● alpha · changed since sent" (amber).
- "was on <thing>" for flows whose object was removed.
- New flow dialog gains an optional **Object** dropdown (the land's objects).

## 5. Object panel → Flows section — FL.6/FL.7

Under Ports in the Place panel, for a selected placed object.

| element | who sees it | content |
|---|---|---|
| Heading | everybody who can read the land's flows | "Flows" · count |
| Flow row | same | name · where it runs chip · last result ("last run 18:00 ✓") |
| **Open** | builders + approvers | opens Automate on that flow |
| **Run on…** | builders | FL.7 dialog |
| **Stop** | builders, when running | "Stop <flow> on <server>? The process stays there; its key is withdrawn." |
| **Detach** | builders | moves it under "Flows without a thing" |
| **Add flow** | builders | name → new flow on this land, attached, with World clock + Write port pointed at this object; opens Automate |
| **Attach existing…** | builders | list of the land's unattached flows |
| Read-only note | non-builders | "Only people who build on <land> change its flows." |

Empty: "No flows on this <thing> yet." (+ **Add flow** for builders)

### 5a. Run on… dialog — FL.7

| field | content |
|---|---|
| Server | dropdown of the player's servers (FL.1), dots shown |
| Start | Manual · Every … (cron, with next-5 preview) · When something happens here (polls World events, cron every minute) |
| Summary | "Sends <flow> to <server>, makes job <flow> there, and gives it a key that can change things on <land> only, for 30 days." |
| Buttons | **Run** / **Cancel** |

Progress lines while running: "sending the flow…", "making the job…",
"issuing the key…", "running on <server>." Refusals:
"<server> did not answer." · "<server> said: <message>" ·
"You may not run flows on <land>." · "<flow> is already running on <server> — Stop it first or Update."
When already running and changed: button reads **Update on <server>**.

---

## 6. Functions (what the UI calls)

| area | world (PostgREST, `api.*`) | process server (`/api/v1`) |
|---|---|---|
| servers | `process_server` select, `save_process_server`, `delete_process_server`, `app_settings` | `GET system/status` |
| blocks | — | `GET system/plugins/available` |
| processes | `save_flow` (Save into my land) | `GET process`, `GET process/<id>/download?type=elx`, `GET process/exists`, `PUT process`, `PATCH process/<id>`, `POST process/duplicate`, `DELETE process/<id>`, `POST process/validate` |
| services | — | `GET service`, `GET service/exists`, `POST service`, `PATCH/DELETE service/<id>` |
| jobs | — | `GET job`, `GET/PATCH/DELETE job/<id>`, `POST job`, `POST job/<id>/run`, `WS job/run` |
| reports | — | `GET report`, `GET report/<id>`, `DELETE report?id=` |
| object flows | `flow` select (with `instance_id`), `save_flow(… instance)` , `objectsOn` | — |
| running | `deploy_flow(flow, server)` → key, `flow_deployment` select, `revoke_flow_key(deployment)` | process create/update + job create/update/delete |
| a running flow | `port_write`, `mover_set`, `world_events`, `world_clock` as role `flow` | (the process server calls these) |
