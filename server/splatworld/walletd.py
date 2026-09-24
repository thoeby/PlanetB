"""walletd — keeps each wallet item's cash (PLAN-money.md §1).

A wallet is a thing in the world, and it has to survive being dropped while
whoever held it is offline, so its cash lives here rather than in a tab: one
GNU Taler wallet file per wallet item, each held open by Taler's own wallet
core (talerwallet.WalletCore) while there is something for it to do.

Invariant 9, as amended: walletd spends only on the instruction of whoever
holds the wallet. Those instructions are wallet_order rows, which only the
holder can write (db/0196, Invariant 6). walletd takes the next one, carries
it out against the issuer, and says what became of it. It decides nothing
about the world, and it connects as the database's owner only to become the
`walletd` role, which may do exactly that and nothing else.
"""
from __future__ import annotations

import base64
import json
import os
import select
import time
import urllib.request
from pathlib import Path

import psycopg

from . import config
from .talerwallet import WalletCore, WalletError
from .walletorders import carry_out, check_held

IDLE_S = 600      # a wallet core with nothing to do is stopped after this
SWEEP_S = 5       # how often held payments and busy wallets are looked at


class Issuer:
    """What walletd needs to know about the world's cash: the issuer, and
    the bank account the world issues the starting amount from."""

    def __init__(self, env: dict[str, str]):
        port = env.get("TALER_EXCHANGE_PORT", "8091")
        self.exchange = env.get("TALER_EXCHANGE_URL") or f"http://localhost:{port}/"
        bport = env.get("TALER_BANK_PORT", "8092")
        self.bank = env.get("TALER_BANK_URL") or f"http://localhost:{bport}/"
        self.password = env.get("TALER_ISSUER_PASSWORD", "issuer-password")
        self.currency = ""
        self.payto = ""

    def hello(self) -> bool:
        """Ask the issuer which currency and which account. False if it does
        not answer — walletd waits for it rather than guessing."""
        try:
            with urllib.request.urlopen(f"{self.exchange}keys", timeout=10) as r:
                keys = json.load(r)
        except OSError:
            return False
        self.currency = keys["currency"]
        self.payto = keys["accounts"][0]["payto_uri"]
        return True

    def alive(self) -> bool:
        try:
            urllib.request.urlopen(f"{self.exchange}config", timeout=3).close()
            return True
        except OSError:
            return False

    def wire(self, reserve: str, amount: str) -> None:
        """The world's admin account pays the issuer for a reserve. The
        reserve is the request_uid: the same reserve twice is one transfer."""
        body = json.dumps({"payto_uri": f"{self.payto}&message={reserve}&amount={amount}",
                           "request_uid": reserve}).encode()
        auth = base64.b64encode(f"admin:{self.password}".encode()).decode()
        req = urllib.request.Request(
            f"{self.bank}accounts/admin/transactions", data=body, method="POST",
            headers={"Content-Type": "application/json", "Authorization": f"Basic {auth}"})
        try:
            urllib.request.urlopen(req, timeout=30).close()
        except urllib.error.HTTPError as err:
            # 409: this reserve was wired already, with this same request.
            if err.code != 409:
                raise


class Walletd:
    def __init__(self, dsn: str, home: Path, issuer: Issuer, log=print):
        self.dsn, self.home, self.issuer, self.log = dsn, home, issuer, log
        self.cores: dict[str, WalletCore] = {}
        self.dirty: set[str] = set()
        self.db: psycopg.Connection | None = None

    # ------------------------------------------------------------ the database
    def connect(self) -> None:
        self.db = psycopg.connect(self.dsn, autocommit=True)
        self.db.execute("SET ROLE walletd")
        self.db.execute("LISTEN wallet_order")
        self.db.execute("SELECT walletd_hello(%s::text)", (self.issuer.currency,))

    def q(self, sql: str, *args):
        return self.db.execute(sql, args).fetchone()[0]

    def said(self, order: dict, state: str | None, said: str | None = None,
             taler_tx: str | None = None, other_tx: str | None = None,
             retry_in: int | None = None) -> None:
        self.db.execute("SELECT walletd_said(%s::bigint, %s::text, %s::text, %s::text, %s::text, %s::int)",
                        (order["id"], state, said, taler_tx, other_tx, retry_in))

    # ------------------------------------------------------------ wallets
    def core(self, wid: str) -> WalletCore:
        c = self.cores.get(wid)
        if c and c.alive():
            return c
        (self.home / "wallets").mkdir(parents=True, exist_ok=True)
        (self.home / "run").mkdir(parents=True, exist_ok=True)
        c = WalletCore(self.home / "wallets" / f"{wid}.sqlite3",
                       on_notify=lambda n, w=wid: self.dirty.add(w),
                       log=self.home / "run" / f"{wid}.log").start()
        exchanges = c.call("listExchanges").get("exchanges", [])
        if not any(e.get("exchangeBaseUrl") == self.issuer.exchange for e in exchanges):
            c.call("addExchange", {"exchangeBaseUrl": self.issuer.exchange})
            tos = c.call("getExchangeTos", {"exchangeBaseUrl": self.issuer.exchange})
            c.call("setExchangeTosAccepted", {"exchangeBaseUrl": self.issuer.exchange,
                                              "etag": tos["currentEtag"]})
        self.cores[wid] = c
        return c

    def seen(self, wid: str) -> None:
        """Write down what a wallet holds, as the wallet says."""
        try:
            bals = self.core(wid).call("getBalances").get("balances", [])
        except (WalletError, RuntimeError, TimeoutError) as err:
            self.log(f"walletd: {wid[:8]} did not say what it holds: {err}")
            return
        mine = [b for b in bals if b.get("scopeInfo", {}).get("currency") == self.issuer.currency]
        b = mine[0] if mine else {}
        amount = lambda a: float((a or "X:0").split(":")[1])
        pending = amount(b.get("pendingIncoming")) > 0 or amount(b.get("pendingOutgoing")) > 0
        self.db.execute("SELECT walletd_seen(%s::uuid, %s::numeric, %s::boolean)",
                        (wid, amount(b.get("available")), pending))

    # ------------------------------------------------------------ the loop
    def step(self) -> bool:
        order = self.q("SELECT walletd_next()")
        if order is None:
            return False
        carry_out(self, order)
        for w in (order.get("wallet_id"), order.get("other_id")):
            if w:
                self.seen(w)
        return True

    def sweep(self) -> None:
        for order in self.q("SELECT walletd_held()"):
            check_held(self, order)
        for wid in set(self.q("SELECT walletd_busy()")) | self.dirty:
            self.seen(wid)
        self.dirty.clear()
        now = time.monotonic()
        for wid, c in list(self.cores.items()):
            if now - c.used > IDLE_S:
                c.stop()
                del self.cores[wid]

    def run(self) -> None:
        while not self.issuer.hello():
            self.log(f"walletd: waiting for the issuer at {self.issuer.exchange}")
            time.sleep(5)
        self.connect()
        self.log(f"walletd: {self.issuer.currency} from {self.issuer.exchange}")
        last = 0.0
        while True:
            while self.step():
                pass
            if time.monotonic() - last > SWEEP_S:
                self.sweep()
                last = time.monotonic()
            if select.select([self.db.pgconn.socket], [], [], SWEEP_S) != ([], [], []):
                for _ in self.db.notifies(timeout=0):
                    pass

    def stop(self) -> None:
        for c in self.cores.values():
            c.stop()


def main(cfg: config.Config) -> int:
    env = {**config.load_dotenv(cfg.repo / ".env"), **os.environ}
    home = Path(env.get("WALLETD_HOME") or cfg.repo / "data" / "walletd")
    d = Walletd(cfg.dsn(), home, Issuer(env), log=lambda m: print(m, flush=True))
    try:
        d.run()
    finally:
        d.stop()
    return 0
