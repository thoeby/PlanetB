# PLAN-identity.md — a player is a verified person

Decisions by the owner, and the stories that prove them. Stories are proven
like PLAYER-RUN.md: a script that behaves like a player, through the page,
from an empty database. Goes with PLAN-money.md: the starting cash is issued
when a player is first verified, not at signup.

## 0. Decisions (made by the owner)

| # | decision |
|---|---|
| I1 | A player is a real, verified person. Verification is by the **Swiss e-ID** (swiyu), or **manually by an admin** for anyone who cannot or will not use it. |
| I2 | The world stores the **fact** of verification, not the identity: verified yes/no, how (e-ID, or manually by which admin), when, and a one-way fingerprint for "one person, one account". No legal name, birth date, document number or photo is stored. |
| I3 | Signing up stays email + password + display name. Other players only ever see the display name and a "verified" mark. |
| I4 | Demo: Swiss players only. |

## 1. What a player meets

**Account → Verify**, two choices:

- **With e-ID.** The page shows a QR code (on a computer) or an "Open swiyu"
  button (on a phone). The swiyu app lists exactly what is asked (see §2) and
  the player approves. Within seconds the page says "Verified with e-ID". The
  wallet with the starting amount appears in the inventory.
- **Without e-ID.** The player enters legal name, birth date, and how the
  admin can check it (in person, video call). The page says "Waiting for an
  admin". An ID document is shown to the admin, never uploaded.

**Before verification** (default, see Open V5) a player can walk, visit and
render for free. Getting land, holding a wallet, building and registering
products say "Verify first" with a link to Account → Verify.

**Admin → Players**: the waiting manual requests, each with name and birth
date as typed. Confirm (records method and the admin) or Refuse (with a note
the player sees). Revoke any verification later, with a note. The typed name
and birth date are dropped once the request is decided; only the fingerprint
stays.

## 2. What is asked from the e-ID

Only what the rules below need, nothing more:

| Asked | Why |
|---|---|
| over 18 (yes/no, not the birth date) | Open V2 |
| nationality | I4, Open V1 |
| family name, given names, birth date | the one-way fingerprint only (I2); read, fingerprinted, discarded |

## 3. Refusals, each a sentence in place

Under the minimum age · not Swiss (per V1) · "an account for this person
already exists" (fingerprint match, e-ID or manual) · approval declined in the
app · request expired (a new QR is one click) · swiyu not reachable ("try
again, or verify without e-ID").

## 4. Behind it (invisible to players)

- The **swiyu Generic Verifier** (the government's open-source verifier
  component) runs as one more process. The operator registers the world once
  as a verifier in the swiyu registry — an operator step outside the code,
  written as a checklist in `docs/runbook.md`.
- Until the e-ID is issued to the public (planned for 1 Dec 2026), stories run
  against the swiyu **public beta** with its test credentials.
- **Invariant 10**: allowed processes add the swiyu verifier.
- **Invariant 9**: the verifier talks to the swiyu registries to check a
  presented credential. The world sends nothing else out.
- **Invariant 6**: "verified" is a database fact checked by row-level
  security on every action it unlocks, never by the page.
- The fingerprint is keyed with a secret of the world, so it cannot be
  reversed by guessing names and birth dates.

## 5. Stories (build order, one commit each)

**ID.0 — Verify before building** (no product change). The verifier runs in
`infra/compose.yml` against the public beta; a script presents a test
credential and receives exactly the fields in §2. The field names are checked
against what the beta actually delivers. Any mismatch: one sentence under
Blocked, stop.

**ID.1 — Unverified.** C signs up → Account says "Not verified" and what
verifying unlocks; "Request land" says "Verify first".

**ID.2 — With e-ID.** C verifies with a test credential → "Verified with
e-ID" within 30 s; the wallet with the starting amount is in the inventory;
"Request land" now works.

**ID.3 — Refused.** A credential under 18, a non-Swiss one (per V1), and a
second account for the same person are each refused with their sentence.
Declining in the app and letting the request expire each say so.

**ID.4 — Manually.** B chooses "Without e-ID", enters name and birth date →
A (admin) sees the request, confirms "checked in person" → B is verified,
wallet appears. Second request: A refuses with a note → the requester sees
the note. A manual request for a person already verified by e-ID is refused
by the fingerprint.

**ID.5 — Revoked.** A revokes B's verification with a note → B sees the note;
actions that need verification say "Verify first" again (V4 for the wallet).

**ID.6 — Failure, always.** The verifier is stopped → Verify says so in place
and offers the manual path; restarted → the e-ID path works again.

## 6. Open (defaults are built until the owner decides)

- **V1** "Swiss": citizens only, or anyone holding a Swiss e-ID (residents
  included)? *Default:* anyone holding a Swiss e-ID.
- **V2** Minimum age. *Default:* 18.
- **V3** One person, one account. *Default:* yes.
- **V4** A revoked player's wallet: can he still spend it? *Default:* he
  keeps holding it but cannot spend until verified again; he can hand it over.
- **V5** What unverified players may do. *Default:* walk, visit, render for
  free.

## Blocked

(Agent writes here, one sentence per item, and stops.)

- ID.0 is not run: the swiyu beta registries (`*.trust-infra.swiyu-int.admin.ch`) and the verifier image's layers on ghcr.io are refused by this container's egress proxy, so neither the verifier nor a test credential can be exercised here.
