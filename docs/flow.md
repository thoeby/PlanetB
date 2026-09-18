# Flows

What the Automate view is, what it stores, and what is still unproven.
`docs/SPEC.md` §2.16 is the product; this is the engineering note beside it.

## What a flow is

An ELX file and a pointer to it. The file is immutable and content-addressed
like every other artifact (Invariant 1) and lives at `/assets/{sha}.elx`; the
pointer is a row of `flow` (db/0133) saying which land it belongs to, what it
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
  `elx_url` in `app_setting`, db/0134). The page POSTs the ELX to
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
