"""Supervises PostgREST.

PostgREST is the API and stays the API: the schema, its grants and its
row-level security are what authorise every client write (Invariant 6), and
none of that survives being reimplemented here. This starts it, waits for it to
answer, and stops it again.
"""
from __future__ import annotations

import shutil
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

from .config import Config

CONF = """\
db-uri = "{dsn}"
db-schemas = "api"
db-anon-role = "anon"
db-pool = 10
jwt-secret = "{secret}"
server-port = {port}
server-host = "127.0.0.1"
db-max-rows = 10000
"""


def find_binary(cfg: Config) -> str | None:
    return shutil.which(cfg.postgrest) or (
        cfg.postgrest if Path(cfg.postgrest).is_file() else None
    )


def missing_message(cfg: Config) -> str:
    return (
        f"PostgREST was not found (looked for {cfg.postgrest!r}).\n"
        "  It is one file. Download the build for your machine from\n"
        "  https://github.com/PostgREST/postgrest/releases and either put it on\n"
        "  your PATH or point POSTGREST at it."
    )


def alive(cfg: Config, timeout: float = 2.0) -> bool:
    try:
        with urllib.request.urlopen(cfg.api_url, timeout=timeout) as res:
            return res.status < 500
    except urllib.error.HTTPError:
        return True  # answering at all is enough; 404 on / is normal
    except OSError:
        return False


class PostgREST:
    """Started on enter, stopped on exit. Nothing else supervises it."""

    def __init__(self, cfg: Config, *, verbose: bool = False):
        self.cfg = cfg
        self.verbose = verbose
        self.proc: subprocess.Popen | None = None
        self._conf: Path | None = None

    def __enter__(self) -> "PostgREST":
        if alive(self.cfg):
            print(f"  API already running on {self.cfg.api_url}")
            return self
        binary = find_binary(self.cfg)
        if not binary:
            raise SystemExit(missing_message(self.cfg))

        handle = tempfile.NamedTemporaryFile(
            "w", suffix=".conf", delete=False, encoding="utf8"
        )
        handle.write(CONF.format(
            dsn=self.cfg.authenticator_dsn(),
            secret=self.cfg.jwt_secret,
            port=self.cfg.api_port,
        ))
        handle.close()
        self._conf = Path(handle.name)

        # PGRST_* in the environment would override the file, and .env sets some.
        env = {k: v for k, v in _clean_env().items() if not k.startswith("PGRST_")}
        self.proc = subprocess.Popen(
            [binary, str(self._conf)], env=env,
            stdout=None if self.verbose else subprocess.DEVNULL,
            stderr=None if self.verbose else subprocess.DEVNULL,
        )
        self._wait()
        return self

    def _wait(self, seconds: float = 20.0) -> None:
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            if self.proc and self.proc.poll() is not None:
                raise SystemExit(
                    "PostgREST stopped straight away. Run with --verbose to see why;\n"
                    "  the usual cause is the authenticator password not matching\n"
                    "  the database (re-run `splatworld init`)."
                )
            if alive(self.cfg, timeout=1.0):
                print(f"  API on {self.cfg.api_url}")
                return
            time.sleep(0.3)
        raise SystemExit(f"PostgREST did not answer on {self.cfg.api_url}")

    def __exit__(self, *exc) -> None:
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.proc.kill()
        if self._conf:
            self._conf.unlink(missing_ok=True)


def _clean_env() -> dict[str, str]:
    import os

    return dict(os.environ)
