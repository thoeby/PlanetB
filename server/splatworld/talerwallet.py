"""One wallet's cash, held by GNU Taler's own wallet core (PLAN-money.md §1).

`taler-wallet-cli advanced serve` keeps one wallet file open and runs its task
loop — withdrawing, merging, refunding what expired — for as long as it runs,
and answers wallet-core requests over a Unix socket. This is the client for
that socket and nothing more: it decides nothing about whose wallet it is.

The socket speaks lines: "%request", a JSON body, "%end" one way;
"%message", a JSON body, "%end" the other, which is either the response to a
request (same id) or a notification.
"""
from __future__ import annotations

import itertools
import json
import os
import shutil
import socket
import subprocess
import tempfile
import threading
import time
from pathlib import Path


_socks = itertools.count(1)


class WalletError(Exception):
    """wallet-core said no. `code` is its TalerErrorCode, `hint` its words."""

    def __init__(self, operation: str, detail: dict):
        self.operation = operation
        self.detail = detail
        self.code = detail.get("code")
        self.hint = detail.get("hint") or detail.get("message") or str(detail)
        super().__init__(f"{operation}: {self.hint} ({self.code})")

    def mentions(self, word: str) -> bool:
        return word in json.dumps(self.detail)


def cli() -> str:
    return os.environ.get("TALER_WALLET_CLI") or shutil.which("taler-wallet-cli") or "taler-wallet-cli"


class WalletCore:
    def __init__(self, db: Path, sock: Path | None = None, on_notify=None,
                 log: Path | None = None):
        # A Unix socket's path is at most 107 bytes, which a wallet's own
        # folder easily is not: by default it goes in the temp folder.
        if sock is None:
            sock = Path(tempfile.gettempdir()) / f"twc-{os.getpid()}-{next(_socks)}.sock"
        self.db, self.sock, self.log = Path(db), Path(sock), log
        self.on_notify = on_notify or (lambda n: None)
        self.proc: subprocess.Popen | None = None
        self.conn: socket.socket | None = None
        self.ids = itertools.count(1)
        self.waiting: dict[str, list] = {}
        self.lock = threading.Lock()
        self.used = time.monotonic()

    # ---------------------------------------------------------------- process
    def start(self, timeout: float = 30) -> "WalletCore":
        self.sock.parent.mkdir(parents=True, exist_ok=True)
        self.sock.unlink(missing_ok=True)
        out = open(self.log, "ab") if self.log else subprocess.DEVNULL
        self.proc = subprocess.Popen(
            [cli(), "--skip-defaults", f"--wallet-db={self.db}",
             "advanced", "serve", f"--unix-path={self.sock}"],
            stdout=out, stderr=out, stdin=subprocess.DEVNULL)
        end = time.monotonic() + timeout
        while True:
            if self.proc.poll() is not None:
                raise RuntimeError(f"wallet core for {self.db.name} exited ({self.proc.returncode})")
            try:
                conn = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                conn.connect(str(self.sock))
                break
            except OSError:
                conn.close()
                if time.monotonic() > end:
                    self.stop()
                    raise RuntimeError(f"wallet core for {self.db.name} did not open its socket")
                time.sleep(0.1)
        self.conn = conn
        conn.sendall(b"%hello-from-client\n")
        threading.Thread(target=self._read, daemon=True).start()
        return self

    def alive(self) -> bool:
        return self.proc is not None and self.proc.poll() is None and self.conn is not None

    def stop(self) -> None:
        if self.conn:
            try:
                self.conn.close()
            except OSError:
                pass
            self.conn = None
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(5)
            except subprocess.TimeoutExpired:
                self.proc.kill()
        with self.lock:
            for slot in self.waiting.values():
                slot[1] = {"type": "error", "error": {"hint": "the wallet core stopped"}}
                slot[0].set()
            self.waiting.clear()

    # ---------------------------------------------------------------- requests
    def call(self, operation: str, args: dict | None = None, timeout: float = 120) -> dict:
        if not self.alive():
            raise RuntimeError(f"wallet core for {self.db.name} is not running")
        self.used = time.monotonic()
        rid = f"r{next(self.ids)}"
        slot = [threading.Event(), None]
        with self.lock:
            self.waiting[rid] = slot
        body = json.dumps({"operation": operation, "id": rid, "args": args or {}})
        self.conn.sendall(f"%request\n{body}\n%end\n".encode())
        if not slot[0].wait(timeout):
            with self.lock:
                self.waiting.pop(rid, None)
            raise TimeoutError(f"{operation} did not answer in {timeout:.0f} s")
        msg = slot[1]
        if msg.get("type") == "error":
            raise WalletError(operation, msg.get("error") or {})
        return msg.get("result") or {}

    def _read(self) -> None:
        buf, body, inside = b"", [], False
        conn = self.conn
        while True:
            try:
                chunk = conn.recv(65536)
            except OSError:
                chunk = b""
            if not chunk:
                break
            buf += chunk
            while b"\n" in buf:
                line, buf = buf.split(b"\n", 1)
                text = line.decode().strip()
                if not inside:
                    inside = text == "%message"
                elif text == "%end":
                    self._deliver("".join(body))
                    body, inside = [], False
                else:
                    body.append(line.decode())
        if self.conn is conn:
            self.stop()

    def _deliver(self, raw: str) -> None:
        try:
            msg = json.loads(raw)
        except ValueError:
            return
        if msg.get("type") == "notification":
            try:
                self.on_notify(msg.get("payload") or {})
            except Exception:  # a notification is news, never a reason to stop
                pass
            return
        with self.lock:
            slot = self.waiting.pop(msg.get("id"), None)
        if slot:
            slot[1] = msg
            slot[0].set()

    # ---------------------------------------------------------------- helpers
    def balance(self, currency: str) -> str:
        """The spendable amount, as wallet-core writes it ("CUR:12.5")."""
        for b in self.call("getBalances").get("balances", []):
            if b.get("scopeInfo", {}).get("currency") == currency:
                return b["available"]
        return f"{currency}:0"

    def transaction(self, tx: str) -> dict:
        return self.call("getTransactionById", {"transactionId": tx})

    def uri_of(self, tx: str, timeout: float = 60) -> str:
        """A purse's taler:// URI, once the issuer has the purse: a request's
        URI exists before its contract is at the issuer, and is no use yet."""
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            t = self.transaction(tx)
            if t.get("talerUri") and t.get("txState", {}).get("minor") == "ready":
                return t["talerUri"]
            time.sleep(0.2)
        raise TimeoutError(f"{tx} has no URI after {timeout:.0f} s")

    def settled(self, tx: str, timeout: float = 60) -> dict:
        """Wait until a transaction is done, failed or aborted, and return it."""
        end = time.monotonic() + timeout
        while True:
            t = self.transaction(tx)
            if t.get("txState", {}).get("major") in ("done", "failed", "aborted", "expired"):
                return t
            if time.monotonic() > end:
                return t
            time.sleep(0.2)
