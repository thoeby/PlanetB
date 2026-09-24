"""What walletd does with each kind of order (db/0196 wallet_order).

Every step is written down as soon as it is taken (taler_tx, other_tx), so an
order walletd was in the middle of when it stopped is picked up where it was
rather than started again: a payment is never made twice.

Nothing here decides whether an order should happen — the database already
did, when the holder of the wallet asked (Invariant 6). This only says, in a
sentence the holder reads, what became of it.
"""
from __future__ import annotations

import time
import urllib.error

from .talerwallet import WalletError

UNREACHABLE = ("The issuer is not reachable — nothing has left the wallet. "
               "It goes through by itself when the issuer is back.")
CAME_BACK = "Went through once the issuer was back."
RETRY_S = 5
DAY = 24 * 3600
ENDED = ("aborted", "failed", "expired")


def later(o: dict, default: int = DAY) -> dict:
    """A purse's expiry: the order's own, or a day from now."""
    at = o.get("expires_at")
    if at:
        from datetime import datetime
        return {"t_s": int(datetime.fromisoformat(at).timestamp())}
    return {"t_s": int(time.time()) + default}


def cash(d, o: dict) -> str:
    return f"{d.issuer.currency}:{float(o['amount']):.2f}"


def short(amount: str) -> str:
    v = float(amount.split(":")[1])
    return f"{v:.2f}"


def unreachable(err: Exception) -> bool:
    if isinstance(err, (TimeoutError, urllib.error.URLError, ConnectionError, OSError)):
        return True
    if isinstance(err, WalletError):
        return err.code in (7032, 7001, 7005) or err.mentions("ECONNREFUSED") \
            or err.mentions("not reachable") or err.mentions("unavailable")
    return False


def carry_out(d, o: dict) -> None:
    kind, state = o["kind"], o["state"]
    step = {("issue", "queued"): issue, ("pay", "queued"): pay,
            ("request", "queued"): ask, ("request", "confirmed"): settle_ask,
            ("hold", "queued"): hold, ("hold", "confirmed"): collect,
            ("hold", "releasing"): release}.get((kind, state))
    if step is None:
        d.said(o, "failed", f"walletd does not know how to {state} a {kind}")
        return
    # MN.7: with the issuer away, no wallet is touched at all, so what it
    # holds is exactly what it held.
    if not d.issuer.alive():
        d.said(o, None, UNREACHABLE, retry_in=RETRY_S)
        return
    try:
        step(d, o)
    except WalletError as err:
        if err.code == 7027 or err.mentions("INSUFFICIENT_BALANCE"):
            held = d.core(o["wallet_id"] if kind != "request" else o["other_id"]).balance(
                d.issuer.currency)
            said = f"This wallet holds {short(held)} — not enough for {float(o['amount']):.2f}."
            d.said(o, "asked" if kind == "request" else "failed", said)
        elif unreachable(err):
            d.said(o, None, UNREACHABLE, retry_in=RETRY_S)
        else:
            d.said(o, "failed", f"The payment did not go through: {err.hint}")
        d.log(f"walletd: order {o['id']} ({kind}): {err}")
    except (OSError, TimeoutError) as err:
        d.said(o, None, UNREACHABLE, retry_in=RETRY_S)
        d.log(f"walletd: order {o['id']} ({kind}): {err}")
    except Exception as err:  # noqa: BLE001 — one order is never the end of walletd
        d.said(o, None, "Not yet: walletd will try it again.", retry_in=30)
        d.log(f"walletd: order {o['id']} ({kind}) went wrong: {err!r}")


def finish(d, o: dict, core, tx: str, done_state: str = "done", said: str = "") -> None:
    """Done when the wallet says so; otherwise looked at again shortly."""
    t = core.settled(tx, timeout=30)
    major = t.get("txState", {}).get("major")
    if major == "done":
        d.said(o, done_state, said or (CAME_BACK if o.get("said") == UNREACHABLE else ""))
    elif major in ENDED:
        d.said(o, "failed", f"The payment did not go through ({major}).")
    else:
        d.said(o, None, "On its way.", retry_in=2)


# ---------------------------------------------------------------- the world

def issue(d, o: dict) -> None:
    """M5: the world pays the wallet out of its issuing account."""
    w = d.core(o["wallet_id"])
    tx = o.get("taler_tx")
    if not tx:
        r = w.call("acceptManualWithdrawal", {"exchangeBaseUrl": d.issuer.exchange,
                                              "amount": cash(d, o)})
        tx, reserve = r["transactionId"], r["reservePub"]
        d.said(o, None, "Being issued.", taler_tx=tx, retry_in=0)
    else:
        reserve = w.transaction(tx)["withdrawalDetails"]["reservePub"]
    d.issuer.wire(reserve, cash(d, o))
    finish(d, o, w, tx)


# ---------------------------------------------------------------- M4

def push(d, o: dict, core) -> str:
    """Cash out of a wallet into a purse; the order remembers the purse."""
    tx = o.get("taler_tx")
    if not tx:
        t = core.call("initiatePeerPushDebit", {"partialContractTerms": {
            "amount": cash(d, o), "summary": o["message"] or "a payment",
            "purse_expiration": later(o)}})
        tx = t["transactionId"]
        o["taler_tx"] = tx
        d.said(o, None, None, taler_tx=tx, retry_in=0)
    return tx


def take(d, o: dict, core, uri: str) -> str:
    tx = o.get("other_tx")
    if not tx:
        p = core.call("preparePeerPushCredit", {"talerUri": uri})
        core.call("confirmPeerPushCredit", {"transactionId": p["transactionId"]})
        tx = p["transactionId"]
        o["other_tx"] = tx
        d.said(o, None, None, other_tx=tx, retry_in=0)
    return tx


def pay(d, o: dict) -> None:
    """Pay: a purse the payee's wallet collects at once."""
    src, dst = d.core(o["wallet_id"]), d.core(o["other_id"])
    tx = push(d, o, src)
    got = take(d, o, dst, src.uri_of(tx))
    finish(d, o, dst, got)


def ask(d, o: dict) -> None:
    """Request: an invoice in the asking wallet, for the payer to confirm."""
    w = d.core(o["wallet_id"])
    t = w.call("initiatePeerPullCredit", {"exchangeBaseUrl": d.issuer.exchange,
                                          "partialContractTerms": {
        "amount": cash(d, o), "summary": o["message"] or "a request",
        "purse_expiration": later(o)}})
    w.uri_of(t["transactionId"])
    d.said(o, "asked", "", taler_tx=t["transactionId"])


def settle_ask(d, o: dict) -> None:
    """The payer said yes: their wallet pays the invoice."""
    req, payer = d.core(o["wallet_id"]), d.core(o["other_id"])
    tx = o.get("other_tx")
    if not tx:
        uri = req.transaction(o["taler_tx"])["talerUri"]
        p = payer.call("preparePeerPullDebit", {"talerUri": uri})
        payer.call("confirmPeerPullDebit", {"transactionId": p["transactionId"]})
        tx = p["transactionId"]
        d.said(o, None, None, other_tx=tx, retry_in=0)
    t = payer.settled(tx, timeout=30)
    if t.get("txState", {}).get("major") == "done":
        finish(d, o, req, o["taler_tx"])
    else:
        d.said(o, None, "On its way.", retry_in=2)


def hold(d, o: dict) -> None:
    """Held: a purse with an expiry, for somebody to collect later."""
    src = d.core(o["wallet_id"])
    tx = push(d, o, src)
    src.uri_of(tx)
    d.said(o, "held", "")


def collect(d, o: dict) -> None:
    src, dst = d.core(o["wallet_id"]), d.core(o["other_id"])
    t = src.transaction(o["taler_tx"])
    if t.get("txState", {}).get("major") in ENDED:
        d.said(o, "returned", "It came back before it was collected.")
        return
    got = take(d, o, dst, t["talerUri"])
    finish(d, o, dst, got)


def release(d, o: dict) -> None:
    """Withdrawn before anyone collected it: the purse is given back."""
    src = d.core(o["wallet_id"])
    if src.transaction(o["taler_tx"]).get("txState", {}).get("major") not in ENDED:
        src.call("abortTransaction", {"transactionId": o["taler_tx"]})
    t = src.settled(o["taler_tx"], timeout=30)
    if t.get("txState", {}).get("major") in ENDED:
        d.said(o, "returned", "It came back.")
    else:
        d.said(o, None, "Coming back.", retry_in=2)


def check_held(d, o: dict) -> None:
    """A held payment nobody collected comes back by itself when it expires;
    an ask nobody paid lapses. Write down that it did."""
    if not o.get("taler_tx"):
        return
    try:
        t = d.core(o["wallet_id"]).transaction(o["taler_tx"])
    except (WalletError, RuntimeError, TimeoutError):
        return
    if t.get("txState", {}).get("major") not in ENDED:
        return
    if o["kind"] == "hold":
        d.said(o, "returned", "It came back uncollected.")
    else:
        d.said(o, "failed", "The ask expired unpaid.")
