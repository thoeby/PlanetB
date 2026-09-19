# Flows

What the Automate view is, what it stores, and what is still unproven.
`docs/SPEC.md` §2.16 is the product; this is the engineering note beside it.

## What a flow is

An ELX file and a pointer to it. The file is immutable and content-addressed
like every other artifact (Invariant 1) and lives at `/assets/{sha}.elx`; the
pointer is a row of `flow` (db/0155) saying which land it belongs to, what it
is called, which file it is, and where the blocks sit.

Layout is never in the ELX. The process server neither reads nor writes it, and
putting it there would make two identical flows two different files. It is
`flow.layout`, beside the pointer.

## Export gives back the file

An export of a saved flow is the saved bytes, not a fresh serialization of the
canvas. The two are not the same: this editor's serializer writes a flow in its
own order (nodes before nets), and a file that came from a process server is
usually the other way round. Re-serializing would be the editor quietly
rewriting somebody else's file, so it does not.

That is also why importing a flow saves the file as it arrived and then saves
only the layout: an imported flow exports byte for byte
(`client/test/run/17-flow-files.spec.js`).

## Validate has two halves, and shows both

- **The process server**, when the operator has set one (Settings → Setup,
  `elx_url` in `app_setting`, db/0156). The page POSTs the ELX to
  `<elx_url>/api/v1/process/validate` and reads the `<elx_api_msg>` envelope
  (`client/flow/validate.js`, copied from the reference editor's `rest.js`).
  It is the authority: it is what will run the flow. No server configured, or
  one that does not answer, is a sentence and nothing more.
- **This page**, always: one source per net, every wired pair allowed by the
  ports' own rule, names unique per scope (`client/js/flowcheck.js`).

The local half checks **the bytes that would be run** — the canvas's when there
are unsaved changes, the saved file's otherwise. That distinction is the whole
use of it: a canvas cannot hold a wire the ports refuse, because litegraph
vetoes the connection as it is made and import drops it. A *file* can, and a
file is what a process server is handed.

## Unproven here

**The process server half has never been run against a real one.** This
container has no process server and none is reachable from it, so
`client/test/e2e/flow-validate.spec.js` skips with
"flow-test: ELX_URL not set, server validation skipped", and story 17 asserts
what the page says when nobody was asked. On a machine that has one:

```
ELX_URL=http://localhost:8088 make flow-test
ELX_URL=http://localhost:8088 make player-run
```

Record the result here when it has been run:

| date | server version | samples validated | story 17 |
|---|---|---|---|
| — | — | unrun | passes without a server |

The two things to watch for on that first run are the envelope's shape (this
code expects `<elx_api_msg><error><code>0`) and CORS: the page is an origin the
process server has to allow, and the sentence it shows when it does not says
exactly that.

## World blocks, and which branch we are on

FND.14 asks the world to be something a flow can reach: five blocks —
**Write Port**, **Read Port**, **Set Mover**, **Events Since**, **World
Clock** — in a plugin of its own, `client/flow/world/`, with one composite
ELX per block under `assets/nodes/`, built only from blocks the bundled
palette already has (`http`, `json`, `strings`, `builtin`, `mathematics`).

The task says to try them on a process server and record which of two
branches we are on:

| | |
|---|---|
| **Branch A** | the process server lists `world` in `/api/v1/system/plugins/available`; World blocks are ordinary `plugin="world"` nodes |
| **Branch B** | it does not; a World block is expanded on export into the composite's own blocks, and the editor regroups them on import |

**We are on neither, because nobody has been able to ask.** There is no
process server in this container and none is reachable — the same blocker
`TASKS-foundation.md` records against FND.2, where `make flow-test` skips
the half that needs one. The plugin is written so that branch A is a copy
and a restart:

```
cp -r client/flow/world <the process server's plugin folder>
# restart it, then:
curl -s <server>/api/v1/system/plugins/available | grep '"world"'
```

If that prints, we are on branch A and nothing further is needed: the
blocks are already `plugin="world"` nodes and the export carries them as
they are. If it does not, branch B's expansion is what to build, and the
naming it needs is written down here first so that both halves agree:
`World <Block> <n> · <inner name>`, with the group in `flow.layout`.

The four addresses the blocks call exist in the database now
(`db/0168_theworldanswersflows.sql`) with the shape they will keep.
`world_clock` answers; `port_write`, `mover_set` and `world_events` refuse
every caller with **"flows do not run yet"** until F10 gives them a
runner. That is deliberate: a block wired to an address that 404s is a
block nobody can validate, and a block wired to one that says no is a
block that is right and early.

### What the editor does with them

The world plugin is in the bundled palette (`client/flow/palette/manifest.json`
lists it at `../world/plugin.xml`; `tools/palette.sh` writes that line), so the
five blocks are searched for and dragged in like any others and are drawn in
the view's own hue like any others.

A World block's inspector has a **World** section above its constants: the
land's objects by the product's name, that object's ports by the product's own
port list (FND.6), and a value widget per port type — a switch for a boolean,
a colour well for a colour. **Pick in world** closes Automate, draws the world
again with the cursor free, says *click an object on <land>*, and takes what
was clicked. All three are written back as plain string constants, which is
what the ELX carries.

Every flow is made with the inputs `world` and `world_key`. While a World block
is in the flow neither can be removed — the row says "used by World blocks" —
because that is the address it writes to and the login it writes as.

## Live, and the clock

FND.15 and FND.16 give a flow two more things to reach for, and give a player
both of them by hand first.

**Ports.** `port_write(p_instance, p_port, p_value)` is implemented for a
player (db/0169): whoever may build on the land a thing stands on may set any
port its product declares, and the value is held to that port's kind. It still
refuses a flow, which has no login of its own until F10. `live_near` is how a
page asks what has changed since the number it last saw; `live_of` is what one
thing is set to.

**Movers.** `mover_set(p_mover, p_fields)` is implemented too (db/0172), with
`movers_near` and `movers_on` beside it. A mover is a line, a speed and a
timetable; `world_clock()` is what makes two players see the same bus at the
same second, and it has answered since FND.14.

`world_events` is still the one that refuses everybody. Nothing reads the
events yet — flows do, from F10 — but they are written now.
