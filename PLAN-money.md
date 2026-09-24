# PLAN-money.md — one primitive: cash in a wallet

Decisions by the owner, and the stories that prove them. Replaces SPEC §5.5
("Prices on jobs") and the credits ledger. Stories are proven like
PLAYER-RUN.md: a script that behaves like a player, through the page, from an
empty database.

## 0. Decisions (made by the owner)

| # | decision |
|---|---|
| M1 | The world gives **one money primitive: cash in a wallet.** No bank, no accounts, no shops, no exchanges, no fees, no taxes. Players build all of those — as flows holding wallets. |
| M2 | Cash is **GNU Taler** digital cash in a closed world currency (no conversion to or from CHF). Not a crypto token, not a chain. |
| M3 | **A wallet is a game object** (an item). Whoever holds it can spend it. Hand it over → the other player has the money. Drop it → anyone can pick it up. Held items cannot be taken. Robbery is a later game mechanic, not excluded. |
| M4 | A wallet does four things: **Pay** (send cash to another wallet, with a message), **Request** (ask a wallet for cash; the payer confirms), **Hand over**, **Drop**. Nothing else. |
| M5 | Every new player's wallet starts with a fixed amount (Admin → World). Where money comes from beyond that is **not decided**; nothing else creates money. |
| M6 | A flow can hold a wallet. That is how a bank, a till, an exchange, a tax, a salary is built — by players. |
| M7 | Swiss players only in the demo. Land titles stay in the land register (GeoServer); IP stays with the real IGE. |

## 1. What runs behind it (invisible to players)

Taler cash needs an issuer that signs it and stops double spending — the role
a central bank's note printing plays for paper money. Taler calls this the
"exchange"; it is not a currency exchange and players never meet it.

- **issuer** (`taler-exchange`): signs cash, checks every payment once. Fed
  only by the world, only for the starting amount.
- **`walletd`** (Taler's own wallet core): keeps each wallet item's cash. A
  wallet lives on the server because an item must survive being dropped while
  its holder is offline.

Amendments:
- **Invariant 5**: rights and editions stay in Postgres. **Money is not in
  Postgres**; Postgres stores only the reference of a payment next to what it
  paid for. The old `ledger` stays read-only as history.
- **Invariant 10**: allowed processes add the issuer and `walletd`, each with
  its own database on the same Postgres server. No bank, no merchant backend.
- **Invariant 9**: `walletd` spends only on the signed instruction of whoever
  holds the wallet (a player, or a flow's own key). It decides nothing.

## 2. How the world's own features use it

| Feature | How |
|---|---|
| Price on a render job | The owner pays the price from his wallet into a payment held with the job. The renderer's wallet collects it when the tile publishes. Not collected before it expires → it returns to the owner by itself. Withdrawing the price = letting it return. |
| Buying a product | The creator's wallet requests the price; the buyer pays; the licence is handed over when the payment is in. |
| Old credits | Paid once as cash into each player's wallet (MN.0). |

## 3. Items (game objects that are held)

Objects today always stand on land and are baked. A wallet needs a second
kind: **items** — never baked, drawn over the splats like movers.

- An item is **held** (by a player or a flow) or **lying** at a position.
  Held items are listed in the inventory.
- Drop → it lies where you stand. Pick up → within reach (see O1).
- Hand over → to a player standing nearby, who accepts or refuses.
- A wallet shows its balance to its holder only.

## 4. Stories (build order, one commit each, players A, B, C)

**MN.0 — The switch.** Old credit balances arrive as cash in each player's
wallet. The wallet panel shows cash and its history. Nothing a player could do
before is lost.

**MN.1 — A new player has a wallet.** C signs up → the inventory holds one
wallet with the starting amount.

**MN.2 — Pay and request.** A pays B 5 with a message → B's wallet +5, the
message shown. B requests 3 from A → A sees it, confirms → paid. A payment
the wallet cannot cover says so.

**MN.3 — Hand over, drop, pick up.** A hands his wallet to B → B holds it and
sees its balance; A cannot spend it. B drops it → C picks it up → C can spend
it, B cannot.

**MN.4 — Rendering pays.** B puts a price on his job → C renders, it
publishes → C's wallet +price. Second job: B withdraws the price before
anyone claims → it returns to B.

**MN.5 — Buying a product.** C prices a product → B buys → C's wallet +price,
B holds the licence.

**MN.6 — A player-built till.** A gives a flow on his land a wallet. The flow
requests 2 from anyone who presses the till → B pays → the flow's "money
received" fires and pays half to C. A takes the wallet back.

**MN.7 — Failure, always.** The issuer is stopped → paying says so on the
wallet, nothing leaves it; restarted → pending payments complete and say so.

## 5. Flow blocks (palette group Money)

Balance · Pay · Request · Money received. Each names the wallet it acts on by
dropdown or "Pick in world", and ends up as valid ELX calling the world's
money API, like the World blocks.

## 6. Step 0 — verify before building (one commit, no product change)

Taler 1.5 in `infra/compose.yml`, currency from config, no conversion. A
script proves: the world funds a new wallet with the starting amount; wallet
pays wallet with a message; wallet requests from wallet; a payment held with
expiry is collected by a third wallet, and a second one returns by itself on
expiry. Any that fails: one sentence under Blocked, stop.

## 7. Open (defaults are built until the owner decides)

- **O1** Items lying on land: can anyone pick them up? *Default:* dropped
  anywhere → anyone; placed on your land (a safe) → only those who may build
  there.
- **O2** May players keep world cash in the real GNU Taler app on their
  phone? *Default:* yes — cash that left the game world.
- **O3** The currency's name and symbol. *Default:* set in Admin → World.
- **O4** Where money comes from beyond the starting amount.

## Blocked

(Agent writes here, one sentence per item, and stops.)

- Step 0 is not run: no Taler is reachable from this container — deb.taler.net, ftp.gnu.org and git.taler.net are refused by the egress proxy, Ubuntu has no taler package and Docker Hub no official image; the Nix binary cache has `taler-exchange` 1.3.0 and `taler-wallet-core` 1.5.10 (no exchange 1.5), and installing Nix here was refused without the operator's permission.
- To be decided with step 0: a Taler issuer credits cash only from a wire gateway's incoming history (libeufin-bank, libeufin-nexus or `taler-fakebank-run`), so the starting amount needs one of those as a third process, or the world's own Postgres serving that history of issuances — M1 and §1 say "no bank".
