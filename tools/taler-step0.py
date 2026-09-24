"""PLAN-money.md §6, step 0: before anything is built on it, prove that GNU
Taler does what the plan needs, with the world's own currency and no fees.

  1. the world funds a new wallet with the starting amount
  2. a wallet pays a wallet, with a message
  3. a wallet requests from a wallet, and the payer confirms
  4. a payment held with an expiry is collected by a third wallet, and a
     second one, never collected, returns by itself when it expires

Run by tools/taler-step0.sh, which starts the issuer and the bank first. The
wallets are throwaway files, each held by its own wallet core
(splatworld.talerwallet), as walletd will hold them.
"""
import base64
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

from splatworld.talerwallet import WalletCore, WalletError

conf = sys.argv[1]
opt = lambda s, o: subprocess.run(["taler-exchange-config", "-c", conf, "-s", s, "-o", o],
                                  check=True, capture_output=True, text=True).stdout.strip()
EXCHANGE, BANK = opt("exchange", "BASE_URL"), opt("libeufin-bank", "BASE_URL")
CUR, PAYTO = opt("taler", "CURRENCY"), opt("exchange-account-1", "PAYTO_URI")
ISSUER = os.environ.get("TALER_ISSUER_PASSWORD", "issuer-password")
START = int(os.environ.get("START_AMOUNT", "100"))

passed = failed = 0


def ok(what, good, got=""):
    global passed, failed
    print(("ok - " if good else "not ok - ") + what + ("" if good else f" (got {got})"), flush=True)
    passed, failed = passed + bool(good), failed + (not good)


def num(amount):
    v = float(amount.split(":")[1])
    return int(v) if v.is_integer() else v


def later(seconds):
    return {"t_s": int(time.time()) + seconds}


def fund(w, amount):
    """The world's admin account wires the amount to the issuer with the
    reserve as its subject. The reserve is also the request_uid, so funding
    one wallet twice is one transfer: the bank refuses the second."""
    w.call("addExchange", {"exchangeBaseUrl": EXCHANGE})
    w.call("setExchangeTosAccepted", {"exchangeBaseUrl": EXCHANGE, "etag": w.call(
        "getExchangeTos", {"exchangeBaseUrl": EXCHANGE})["currentEtag"]})
    r = w.call("acceptManualWithdrawal", {"exchangeBaseUrl": EXCHANGE, "amount": f"{CUR}:{amount}"})
    body = json.dumps({"payto_uri": f"{PAYTO}&message={r['reservePub']}&amount={CUR}:{amount}",
                       "request_uid": r["reservePub"]}).encode()
    auth = base64.b64encode(f"admin:{ISSUER}".encode()).decode()
    urllib.request.urlopen(urllib.request.Request(
        f"{BANK}accounts/admin/transactions", data=body, method="POST",
        headers={"Content-Type": "application/json", "Authorization": f"Basic {auth}"}), timeout=30)
    return w.settled(r["transactionId"])


def push(w, amount, summary, seconds=3600):
    t = w.call("initiatePeerPushDebit", {"partialContractTerms": {
        "amount": f"{CUR}:{amount}", "summary": summary, "purse_expiration": later(seconds)}})
    return t["transactionId"], w.uri_of(t["transactionId"])


def collect(w, uri):
    p = w.call("preparePeerPushCredit", {"talerUri": uri})
    w.call("confirmPeerPushCredit", {"transactionId": p["transactionId"]})
    return w.settled(p["transactionId"])


def main():
    home = Path(tempfile.mkdtemp(prefix="taler-step0-"))
    wallets = {n: WalletCore(home / f"{n}.sqlite3", home / f"{n}.sock",
                             log=home / f"{n}.log").start() for n in "abc"}
    a, b, c = wallets["a"], wallets["b"], wallets["c"]
    bal = lambda w: num(w.balance(CUR))
    try:
        # 1 ---------------------------------------------------------------
        for w in (a, b, c):
            fund(w, START)
        ok("a new wallet holds the starting amount", bal(a) == START, bal(a))

        # 2 ---------------------------------------------------------------
        tx, uri = push(a, 5, "for the bread")
        got = collect(b, uri)
        a.settled(tx)
        ok("A pays B 5: A has 5 less", bal(a) == START - 5, bal(a))
        ok("A pays B 5: B has 5 more", bal(b) == START + 5, bal(b))
        ok("the message arrives with it", got.get("info", {}).get("summary") == "for the bread",
           got.get("info"))
        try:
            push(a, 100000, "too much")
            ok("a payment the wallet cannot cover is refused", False, "it was not")
        except WalletError as e:
            ok("a payment the wallet cannot cover is refused, and says so",
               e.mentions("INSUFFICIENT_BALANCE") or e.mentions("insufficient"), e.hint)

        # 3 ---------------------------------------------------------------
        t = b.call("initiatePeerPullCredit", {"exchangeBaseUrl": EXCHANGE, "partialContractTerms": {
            "amount": f"{CUR}:3", "summary": "the rest", "purse_expiration": later(3600)}})
        p = a.call("preparePeerPullDebit", {"talerUri": b.uri_of(t["transactionId"])})
        ok("A sees what is asked", p["contractTerms"]["summary"] == "the rest", p["contractTerms"])
        a.call("confirmPeerPullDebit", {"transactionId": p["transactionId"]})
        a.settled(p["transactionId"]), b.settled(t["transactionId"])
        ok("B requests 3 from A, A confirms: A", bal(a) == START - 8, bal(a))
        ok("B requests 3 from A, A confirms: B", bal(b) == START + 8, bal(b))

        # 4 ---------------------------------------------------------------
        tx, uri = push(b, 4, "held")
        ok("a held payment has left B", bal(b) == START + 4, bal(b))
        collect(c, uri)
        b.settled(tx)
        ok("a third wallet collects it", bal(c) == START + 4, bal(c))

        tx, _ = push(b, 6, "held, never collected", seconds=15)
        ok("a second held payment has left B", bal(b) == START - 2, bal(b))
        print("# waiting for it to expire uncollected", flush=True)
        end = time.monotonic() + 180
        while bal(b) != START + 4 and time.monotonic() < end:
            time.sleep(2)
        ok("an uncollected payment returns by itself when it expires", bal(b) == START + 4,
           f"B has {bal(b)}, {b.transaction(tx).get('txState')}")
    finally:
        for w in wallets.values():
            w.stop()
    print(f"# {passed} passed, {failed} failed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
