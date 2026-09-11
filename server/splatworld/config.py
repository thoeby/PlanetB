"""Where everything is, and on which ports.

Values come from the environment, from a .env file beside the repo, or from the
command line — in that order of increasing precedence. The defaults are the
ones the rest of the repo already assumes (localhost:5432, files on 8080, API on
3000), so a checkout that worked with the Makefile works here unchanged.
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path


def _repo_root() -> Path:
    """The checkout this package lives in, so db/ and client/ can be found.

    Installed elsewhere (pip install of a wheel), SPLATWORLD_REPO says where.
    """
    env = os.environ.get("SPLATWORLD_REPO")
    if env:
        return Path(env).expanduser().resolve()
    here = Path(__file__).resolve()
    for parent in here.parents:
        if (parent / "db").is_dir() and (parent / "client").is_dir():
            return parent
    return Path.cwd()


def load_dotenv(path: Path) -> dict[str, str]:
    """The .env format the Makefile already uses: KEY=value, # comments."""
    out: dict[str, str] = {}
    if not path.is_file():
        return out
    for line in path.read_text(encoding="utf8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        out[key.strip()] = value.strip().strip('"').strip("'")
    return out


# One value of a libpq keyword connection string. Single quotes around it, with
# backslashes and quotes escaped, is what libpq itself documents.
def _libpq(value: str) -> str:
    return "'" + str(value).replace("\\", "\\\\").replace("'", "\\'") + "'"


@dataclass
class Config:
    repo: Path = field(default_factory=_repo_root)
    host: str = "127.0.0.1"
    port: int = 8080

    pg_host: str = "localhost"
    pg_port: int = 5432
    pg_user: str = "postgres"
    pg_password: str = "postgres"
    pg_database: str = "splatworld"

    jwt_secret: str = "dev-secret-change-me-0123456789abcdef"
    authenticator_password: str = "authenticator"
    geoserver_password: str = "geoserver"

    api_port: int = 3000
    postgrest: str = "postgrest"

    files_root: Path | None = None

    @property
    def client_dir(self) -> Path:
        return self.repo / "client"

    @property
    def migrations_dir(self) -> Path:
        return self.repo / "db"

    @property
    def files(self) -> Path:
        return self.files_root or (self.repo / "infra" / "files")

    @property
    def api_url(self) -> str:
        return f"http://127.0.0.1:{self.api_port}"

    def dsn(self, database: str | None = None) -> str:
        return (
            f"host={self.pg_host} port={self.pg_port} user={self.pg_user} "
            f"password={self.pg_password} dbname={database or self.pg_database}"
        )

    def authenticator_dsn(self) -> str:
        # Keyword form, like dsn() above, not a URL. A URL has nowhere to put a
        # Unix socket directory, and PGHOST=/var/run/postgresql is the default a
        # Debian or Ubuntu install leaves behind: the URL came out as
        # postgres://authenticator:pw@/var/run/postgresql:5432/splatworld, which
        # PostgREST cannot parse, so it answered 503 "Could not query the
        # database for the schema cache" for ever while `doctor` reported the
        # database healthy — psycopg takes the keyword form and connected fine.
        # Values are quoted because a password may hold a space or a quote.
        return (
            f"host={_libpq(self.pg_host)} port={_libpq(str(self.pg_port))} "
            f"user=authenticator password={_libpq(self.authenticator_password)} "
            f"dbname={_libpq(self.pg_database)}"
        )


# Environment name -> Config field. The PG* names are the ones psql and the
# Makefile already use, so one .env drives both.
_FIELDS = {
    "PGHOST": "pg_host",
    "PGPORT": "pg_port",
    "PGUSER": "pg_user",
    "PGPASSWORD": "pg_password",
    "PGDATABASE": "pg_database",
    "JWT_SECRET": "jwt_secret",
    "AUTHENTICATOR_PASSWORD": "authenticator_password",
    "GEOSERVER_DB_PASSWORD": "geoserver_password",
    "SPLATWORLD_PORT": "port",
    "SPLATWORLD_HOST": "host",
    "SPLATWORLD_API_PORT": "api_port",
    "POSTGREST": "postgrest",
}

_INTS = {"port", "api_port", "pg_port"}


def load(overrides: dict[str, object] | None = None) -> Config:
    cfg = Config()
    values = {**load_dotenv(cfg.repo / ".env"), **os.environ}
    for env_name, attr in _FIELDS.items():
        raw = values.get(env_name)
        if raw in (None, ""):
            continue
        setattr(cfg, attr, int(raw) if attr in _INTS else raw)
    if values.get("FILES_ROOT"):
        root = Path(values["FILES_ROOT"])
        cfg.files_root = root if root.is_absolute() else (cfg.repo / root).resolve()
    for key, value in (overrides or {}).items():
        if value is not None:
            setattr(cfg, key, value)
    return cfg


def save(cfg: Config, values: dict[str, str]) -> Path:
    """Writes settings into the .env beside the checkout, so nothing is retyped.

    The same file the Makefile and every tool already read. Keys that are there
    are replaced in place; new ones are appended. Anything the file has that we
    were not asked about is left alone, comments and all.
    """
    path = cfg.repo / ".env"
    lines = path.read_text(encoding="utf8").splitlines() if path.is_file() else []
    remaining = dict(values)
    out = []
    for line in lines:
        key = line.split("=", 1)[0].strip() if "=" in line else ""
        if key in remaining:
            out.append(f"{key}={remaining.pop(key)}")
        else:
            out.append(line)
    if remaining and out and out[-1].strip():
        out.append("")
    out.extend(f"{k}={v}" for k, v in remaining.items())
    path.write_text("\n".join(out) + "\n", encoding="utf8")
    return path
