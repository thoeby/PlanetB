"""Supervises PostgREST.

PostgREST is the API and stays the API: the schema, its grants and its
row-level security are what authorise every client write (Invariant 6), and
none of that survives being reimplemented here. This starts it, waits for it to
answer, and stops it again.
"""
from __future__ import annotations

import collections
import os
import shutil
import subprocess
import sys
import tempfile
import threading
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


# Windows only. PostgREST's Windows build links libpq dynamically and ships
# without it: started with PostgreSQL's bin directory off PATH, it dies before
# it prints anything, with a "libpq.dll was not found" box. That directory is
# where psql lives, and where the installer puts every world by default.
def _candidate_pg_bins() -> list[Path]:
    found: list[Path] = []
    psql = shutil.which("psql")
    if psql:
        found.append(Path(psql).parent)
    for drive in ("C:/Program Files", "C:/Program Files (x86)"):
        root = Path(drive) / "PostgreSQL"
        if root.is_dir():
            found += sorted((v / "bin" for v in root.iterdir()), reverse=True)
    return found


def pg_bin(candidates) -> Path | None:
    """The first of these that actually holds libpq.dll."""
    for path in candidates:
        if (Path(path) / "libpq.dll").is_file():
            return Path(path)
    return None


def with_libpq(env: dict[str, str]) -> dict[str, str]:
    """PostgreSQL's bin on PATH, so postgrest.exe can load libpq.dll."""
    if not sys.platform.startswith("win"):
        return env
    found = pg_bin(_candidate_pg_bins())
    if not found or str(found).lower() in env.get("PATH", "").lower():
        return env
    return {**env, "PATH": f"{found}{os.pathsep}{env.get('PATH', '')}"}


def alive(cfg: Config, timeout: float = 2.0) -> bool:
    try:
        with urllib.request.urlopen(cfg.api_url, timeout=timeout) as res:
            return res.status < 500
    except urllib.error.HTTPError as err:
        # 404 on / is normal and means it is up. A 5xx is not: a PostgREST that
        # cannot reach the database answers 503 "Could not query the database
        # for the schema cache" to everything, and counting that as alive meant
        # run() adopted it, started nothing, and served a world whose every API
        # call failed — through restart after restart, saying "API already
        # running" each time.
        return err.code < 500
    except OSError:
        return False


class PostgREST:
    """Started on enter, stopped on exit. Nothing else supervises it."""

    def __init__(self, cfg: Config, *, verbose: bool = False):
        self.cfg = cfg
        self.verbose = verbose
        self.proc: subprocess.Popen | None = None
        self._conf: Path | None = None
        # The last of what it said. PostgREST that dies says why — in its own
        # output, which used to go to the bin unless --verbose was on, leaving
        # this to guess out loud instead (and guess wrong).
        self._said: collections.deque[str] = collections.deque(maxlen=40)
        self._keep_conf = False

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
        env = with_libpq(env)
        # Piped, never DEVNULL: a pipe nobody reads fills up and stops the
        # process writing to it, so the reader below runs either way and only
        # the echoing depends on --verbose.
        self.proc = subprocess.Popen(
            [binary, str(self._conf)], env=env,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, encoding="utf8", errors="replace", bufsize=1,
        )
        threading.Thread(target=_drain, daemon=True,
                         args=(self.proc, self._said, self.verbose)).start()
        self._wait()
        return self

    def _wait(self, seconds: float = 20.0) -> None:
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            if self.proc and self.proc.poll() is not None:
                self._keep_conf = True
                raise SystemExit(self._died())
            if alive(self.cfg, timeout=1.0):
                print(f"  API on {self.cfg.api_url}")
                return
            time.sleep(0.3)
        raise SystemExit(f"PostgREST did not answer on {self.cfg.api_url}")

    def _died(self) -> str:
        """What it said before it went, which beats anything guessed here."""
        # Give the reader a moment: the process is gone, its last lines may not
        # have crossed the pipe yet.
        time.sleep(0.3)
        code = self.proc.returncode if self.proc else "?"
        lines = [f"PostgREST stopped straight away (exit {code}). It said:"]
        said = [line for line in self._said if line.strip()]
        lines += [f"  {line}" for line in said[-12:]] or ["  nothing at all."]
        if not said and sys.platform.startswith("win") and not pg_bin(_candidate_pg_bins()):
            lines.append("  Saying nothing at all on Windows is usually libpq.dll:"
                         " postgrest.exe")
            lines.append("  needs PostgreSQL's bin directory (the one with psql.exe)"
                         " on PATH.")
        lines.append(f"\n  Its config is still at {self._conf}, so you can run it"
                     " by hand:")
        lines.append(f"    {self.cfg.postgrest} {self._conf}")
        return "\n".join(lines)

    def __exit__(self, *exc) -> None:
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.proc.kill()
        if self._conf and not self._keep_conf:
            self._conf.unlink(missing_ok=True)


def _drain(proc: subprocess.Popen, into, echo: bool) -> None:
    """Read the child's output for as long as it has any."""
    if not proc.stdout:
        return
    for line in proc.stdout:
        into.append(line.rstrip())
        if echo:
            print(line, end="")


def _clean_env() -> dict[str, str]:
    import os

    return dict(os.environ)
