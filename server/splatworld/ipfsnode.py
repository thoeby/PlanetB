"""The operator's IPFS node, beside the file store (TASKS-live.md LV.11).

`splatworld run` starts tools/node.mjs as it starts PostgREST, and stops it
with the world. After a PUT has passed can_write the store hands the node the
bytes; the node adds them with the world's fixed settings and records the
file's CID (db/0212). GET /ipfs/{cid} on the store is the node's answer, the
fallback for a tab that no peer answered (LV.12).

The node is the file store's other half, not the world's: a world whose node
is not running still stores and serves every file, and says so in `doctor`.
"""

from __future__ import annotations

import collections
import json
import os
import re
import shutil
import subprocess
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

from .config import Config

NODE_PORT = int(os.environ.get("SPLATWORLD_NODE_PORT", "8095"))


def url(cfg: Config) -> str:
    return f"http://127.0.0.1:{getattr(cfg, 'node_port', NODE_PORT)}"


def alive(cfg: Config, timeout: float = 1.0) -> bool:
    try:
        with urllib.request.urlopen(url(cfg) + "/healthz", timeout=timeout) as res:
            return res.status == 200
    except (urllib.error.URLError, OSError):
        return False


def missing(cfg: Config) -> str | None:
    """Why the node cannot be started here, or None."""
    if not shutil.which("node"):
        return "node is not installed, so the IPFS node (tools/node.mjs) cannot run"
    if not (cfg.repo / "node_modules" / "helia").is_dir():
        return "the IPFS node needs `npm install` in the checkout (helia is missing)"
    return None


def add(cfg: Config, data: bytes, sha256: str) -> str | None:
    """Hand the node a file the store just accepted; its CID, or None."""
    req = urllib.request.Request(url(cfg) + "/add", data=data, method="POST",
                                 headers={"X-Sha256": sha256,
                                          "Content-Type": "application/octet-stream"})
    try:
        with urllib.request.urlopen(req, timeout=120) as res:
            return json.loads(res.read()).get("cid")
    except (urllib.error.URLError, OSError, ValueError):
        return None


def fetch(cfg: Config, cid: str, filename: str = "") -> tuple[int, bytes]:
    """The node's answer for /ipfs/{cid}: (status, bytes)."""
    query = "?filename=" + urllib.parse.quote(filename) if filename else ""
    return ask(cfg, f"/ipfs/{cid}{query}")


STORED = re.compile(r"/(?:tiles/\d+/\d+/\d+|assets)/([0-9a-f]{64})\.([a-z0-9]+)")
_alive_at: dict[str, float] = {}


def redirect_for(cfg: Config, path: str) -> str | None:
    """LV.14: where a GET of an old path goes — /ipfs/{cid} once the world has
    a CID for the file and the node is there to answer; None serves it from
    the store as before (infra/nginx.conf asks db/0215 file_at the same)."""
    m = STORED.fullmatch(path)
    if not m:
        return None
    now = time.monotonic()
    if now - _alive_at.get("ok", -99) > 5:
        if not alive(cfg, timeout=0.5):
            return None
        _alive_at["ok"] = now
    req = urllib.request.Request(f"{cfg.api_url}/rpc/cid_of?sha256={m.group(1)}",
                                 headers={"Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=10) as res:
            cid = json.loads(res.read() or b"null")
    except (urllib.error.URLError, OSError, ValueError):
        return None
    return f"/ipfs/{cid}?filename={m.group(1)}.{m.group(2)}" if cid else None


def ask(cfg: Config, path: str) -> tuple[int, bytes]:
    """The node's answer for a GET: (status, bytes)."""
    try:
        with urllib.request.urlopen(url(cfg) + path, timeout=120) as res:
            return res.status, res.read()
    except urllib.error.HTTPError as err:
        return err.code, err.read()
    except (urllib.error.URLError, OSError):
        return 503, b"the IPFS node is not running"


class Node:
    """Started on enter, stopped on exit; skipped, and said, when it cannot run."""

    def __init__(self, cfg: Config, *, verbose: bool = False):
        self.cfg, self.verbose = cfg, verbose
        self.proc: subprocess.Popen | None = None
        self.said: collections.deque[str] = collections.deque(maxlen=40)

    def __enter__(self) -> "Node":
        if alive(self.cfg):
            print(f"  IPFS node already running on {url(self.cfg)}")
            return self
        why = missing(self.cfg)
        if why:
            print(f"  note: {why}; files are served without CIDs")
            return self
        env = {**os.environ, "FILES_ROOT": str(self.cfg.files), "API_URL": self.cfg.api_url,
               "JWT_SECRET": self.cfg.jwt_secret,
               "NODE_HTTP_PORT": str(getattr(self.cfg, "node_port", NODE_PORT))}
        self.proc = subprocess.Popen(["node", str(self.cfg.repo / "tools" / "node.mjs")],
                                     env=env, cwd=str(self.cfg.repo), stdout=subprocess.PIPE,
                                     stderr=subprocess.STDOUT, text=True, bufsize=1)
        threading.Thread(target=self._drain, daemon=True).start()
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline and self.proc.poll() is None:
            if alive(self.cfg):
                print(f"  IPFS node on {url(self.cfg)}")
                # What the store held before the node did gets its CID too.
                threading.Thread(target=self._backfill, daemon=True).start()
                return self
            time.sleep(0.3)
        print("  note: the IPFS node did not come up:\n    "
              + "\n    ".join(list(self.said)[-6:] or ["it said nothing"]))
        return self

    def _backfill(self) -> None:
        try:
            n = backfill(self.cfg, say=self.said.append)
        except Exception as err:  # noqa: BLE001 - a world without it still serves
            self.said.append(f"backfill: {err}")
            return
        if n:
            print(f"  IPFS node: {n} stored file(s) given a CID")

    def _drain(self) -> None:
        for line in self.proc.stdout if self.proc and self.proc.stdout else []:
            self.said.append(line.rstrip())
            if self.verbose:
                print(line, end="")

    def __exit__(self, *exc) -> None:
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.proc.kill()


def backfill(cfg: Config, say=print) -> int:
    """LV.14: every file the store held before its node did, handed to it now,
    so it has a CID and the old path can send a GET on to it. The node records
    each (db/0212); a file already recorded is skipped."""
    import psycopg

    with psycopg.connect(cfg.dsn(), autocommit=True) as conn:
        known = {r[0] for r in conn.execute("SELECT sha256 FROM file_cid")}
    added = 0
    for top in ("assets", "tiles"):
        for path in sorted((cfg.files / top).rglob("*")):
            m = STORED.fullmatch("/" + path.relative_to(cfg.files).as_posix())
            if not m or m.group(1) in known or not path.is_file():
                continue
            if add(cfg, path.read_bytes(), m.group(1)):
                known.add(m.group(1))
                added += 1
            else:
                say(f"  the node did not take {path.relative_to(cfg.files)}")
    return added
