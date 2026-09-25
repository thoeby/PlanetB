# TASKS-live.md — live objects, the store, and files that live anywhere

The owner's list of 2026-09-25, with the plan that implements it. Read
`CLAUDE.md` first; every invariant holds. `VISION.md` is named as the first
thing to read, and no branch of this repository has it: the decisions below
are the ones the owner wrote into the list, and nothing is inferred from a
file that is not there.

One task = one commit `LV.x: title`, `make gate` green, and the player-run
story named in the task green. User logic is ELX on a process server, always;
everything the tab does here is built-in code.

## Decisions this list implements

* No version history. A SAN has one pointer per channel (`current`,
  `legacy`); a right follows a channel or pins one hash. Old hashes stay
  reachable through IPFS for as long as anyone pins them.
* No git, no Forgejo. A registrar script takes a folder.
* sha256 stays the identity; the IPFS CID is stored beside it and derived with
  fixed settings so anyone can recompute it.
* A trigger is `{kind, params}`; kinds grow in built-in code, never a list in
  the database.

## Decisions made while planning (the list left them open)

* **The world clock is the one of db/0168.** A live write records
  `world_clock()`; every tab measures its own clock against it once
  (`client/js/movers.js`) and evaluates motion from the row, never per frame
  from the network.
* **Where a tween starts is the database's.** A pose write stores `start`:
  where the part was at the write's clock, worked out in SQL from the row it
  replaces. Every tab evaluates the same `start → to` over `over_s` from the
  same clock, so two tabs agree to the frame without talking to each other.
* **Every part with a role is left out of the bake.** assemble-v17 left only
  a screen's surface out, and baked a door where the maker left it.
  assemble-v18 leaves out every role part (Invariant 2: dataset-v9 carries
  it). A joint on the root node is the whole model, drawn live.
* **A carried thing is never baked.** A product that declares `carry` is left
  out of `tile_world`, and moving it dirties no tile.
* **A held thing has no position.** `instance.lon/lat` become nullable; the
  holder and the position are exclusive by a CHECK, and every spatial query
  already skips a row whose point is null.
* **`order` is `store_order`.** `order` is a reserved word; every name the
  list gives is kept otherwise.
* **The root area is the world's ground.** There is no area above all others;
  `ground` (db/0039) is the one row every land is inside of, so the operator's
  cut is `ground.rules.store_cut`, paid to whoever set the ground.
* **A product's versions are a log, not a history.** `asset_version(san, sha,
  channel, fix, needs, at)` records each pointer move, because a buy-once right
  asks "was there a fix since I bought" and consent asks "what did that version
  need". Nothing is ever rebuilt from it.
* **Delegated work has no tile.** `job` is a tile at a version and `atom` a
  piece of one, so `flow` and `host` work is a table of its own, `duty`, in the
  same pool panel, paid from the same escrow, pro rata the same way.
* **Tabs fetch from each other over one small protocol.** Helia gives the tab
  a libp2p node, a block store and the importer; a fetch asks a named peer
  (`/splatworld/fetch/1`) so a wrong answer is pinned on who gave it.
* **WebTransport is dialled, not listened on, in node.** js-libp2p has no
  WebTransport listener in node; the operator node listens on WebSockets and
  WebRTC-direct and relays. Said in `tools/node.mjs`.

Migrations continue at `db/0200`, player-run stories at 40.

---

## A — Movement and triggers

### LV.1 A part may move — story 40

* `check_marks` accepts role `joint`; `check_ports` accepts kinds `pose`
  `{to:{x,y,z,yaw,pitch,roll,scale}, over_s}`, `path` `{route_m, speed,
  loop}`, `spin` `{axis, rpm}`; `check_port_value` holds values to them.
* `live_state.clock` (world clock of the write) and `live_state.start` (where
  the part was then). `live_near`/`live_of` return both.
* `client/lib/joint.js`: `jointAt(row, t)`, pure. `livedraw.js` applies it
  every frame to joint parts, against the world clock.
* `client/lib/marks.js`: role *Moves*, ports `pose`, `path`, `spin`. The
  Ports section writes each kind in its own few fields.
* assemble-v18 / dataset-v9: no role part is baked.
* **Story 40**: C registers a crane whose arm is a joint with a `pose` port;
  B places it; A and B stand by it; B swings the arm (yaw 90 over 4 s); both
  tabs put the arm at yaw 90 from the same world second. The tile under it
  keeps its published sog.

### LV.2 Products declare triggers — story 41

* `asset.parts.triggers: [{kind, params}]`, shape only (kind a token, params
  an object), in the canonical text (a product with a trigger is another
  product). `asset.parts.rate`: firings per minute per thing, default 30.
* Built-in kinds (`client/js/triggers.js`): `click`, `near {m}`, `far {m}`,
  `key {key, when}`, `use {part}`.
* `emit_trigger(instance, kind, part, clock)`: once per firing; refused
  above the declared rate, and for a kind the product does not declare.
  `world_event.kind` gains `trigger`.
* `world_events(after)` answers: a flow key sees its land's events, a player
  the lands they build on. `{events, last_id}`.
* The elx fixture runs *Events Since* too.
* **Story 41**: a gate declares `near 5`; B walks up; one event; B's flow on
  alpha, run, reads it with *Events Since*.

### LV.3 `motion` and `interact` plugins — story 42

* `client/flow/motion/`: Move To, Turn To, Scale To, Follow Path, Spin, Stop.
  `client/flow/interact/`: On Trigger (kind as constant), Give, Take, Post.
  Composite ELX over `world`'s blocks and the bundled ones, in the palette
  manifest like `world`.
* `post_note(instance, text)`: a line said over a thing, as a world event.
* `make flow-test` validates every composite.
* **Story 42**: B builds the gate's flow from *On Trigger* and *Turn To*
  only, runs it on alpha; walking up opens the gate for A too.

## B — Holding things

### LV.4 An object may be held — story 43

* `instance.holder_player`, `instance.holder_instance`; exclusive with a
  position. `take(instance)`, `drop(instance, lon, lat, h)`,
  `give(instance, to)`: each a CAS on the holder, refusals in words.
* Products declare `carry {kind}` (may be taken) and `hold {capacity,
  kinds}` (a container).
* Held things are not baked and still answer ports.
* **Story 43**: B takes a crate, walks 100 m, drops it; A sees it vanish and
  reappear; A and C race for it; one has it, the other is told who.

## C — The store

### LV.5 Orders replace `buy_asset` — pgTAP

* `store_order(id, san, buyer, qty, amount, term, state, provider,
  provider_ref, ref)`. `order_create(san, qty, term)`, `order_confirm(id,
  proof)`, `order_refund(id)`. Provider `internal` debits and confirms in one
  transaction; any other (`app_setting.store_provider`) is left pending.
* `buy_asset(san)` is `order_create(san, 1, null)`. The operator's cut is
  `ground.rules.store_cut`.

### LV.6 Channels on rights — pgTAP

* `asset.pointer {current, legacy}`, `asset.policy` (`once` | `subscription`
  | `pinned`), `asset.term`; `asset_version` log. `asset_right.follow`,
  `.sha`, `.until`. `set_pointer(san, channel, sha, fix, needs)`.
  `right_sha(san, holder)`.
* The product card says which model applies before Buy.

### LV.7 Plugins and flows are products — story 44

* Types `plugin` (canonical tar of a plugin folder) and `flow` (an ELX).
* Install: the tab sends the folder to the chosen server's plugin path; the
  fixture has one.
* **Story 44**: B buys `motion`, installs it on alpha; the palette's Motion
  group says it is from alpha.

### LV.8 Registrar — api-test

* `tools/register.py <folder>`: `model.glb` canonicalised by
  `tools/canon.mjs`, `product.json` validated, `flow.elx` hashed, artifacts
  PUT, `register_asset`, `set_pointer`. `tools/register-test.sh`.

### LV.9 Flows declare what they need; owners consent — story 45

* `product.json.needs`; `instance.consent {sha, needs}`; `instance_sha()`.
  A move that asks for more stays on the old hash; the Place panel says so;
  **Allow** moves it.

## D — Delegated flows

### LV.10 `flow` work type — story 46

* `duty` (op `flow` | `host`), `offer_flow`, `claim_duty`, `duty_receipt`,
  `settle_duty`. The key is scoped to the land, the needs and the term.
  Jobs with `pay` needs are not offered to strangers.
* **Story 46**: B delegates the gate's flow; C's server beta runs it under
  the job's key; after the term the process is gone from beta and the key
  refuses.

## E — Files anywhere (browser only)

### LV.11 Operator node — files-test

* `tools/node.mjs`: Helia + libp2p (WebSockets, WebRTC-direct, relay),
  blocks under `infra/files/blocks`, `/ipfs/{cid}` over HTTP, `/add`.
* The files server adds each accepted PUT (CIDv1, raw leaves, 256 KiB,
  174 links) and records `artifact.cid`; `server/splatworld/cid.py`
  recomputes it without the node. `splatworld run` starts it; `doctor`
  reports it.

### LV.12 Tabs are peers — story 47

* Helia in the tab (`client/vendor/helia/`, built by `tools/vendor.sh`),
  `client/js/peers.js`: peer → operator node → `/ipfs/{cid}`, hash on
  arrival, a liar dropped for the session and said. `peer` table,
  `register_peer`, `unregister_peer`.

### LV.13 `host` work type — story 48

* `duty` op `host`: a region's CIDs for a term; receipts signed by the
  fetching tab; paid pro rata by bytes, from distinct players, CIDs the
  region's manifests name.

### LV.14 Old paths retire — files-test

* `GET /tiles/…` and `GET /assets/…` redirect to `/ipfs/{cid}`; PUT
  unchanged. nginx and `server/` both. No tab code reads `/tiles`.

## Later, not in this list

A desktop client that pins for good; IPNS is not used — the pointer lives in
the world.
