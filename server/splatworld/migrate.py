"""Creates the database and applies db/*.sql.

The same files, in the same order, that `make db-reset` applies with psql —
minus psql itself, so a machine that has Python and a PostgreSQL server needs
nothing else. Only two migrations use a psql variable (:'authpw', :'geopw') and
those are substituted here.
"""
from __future__ import annotations

import re
from pathlib import Path

import psycopg
from psycopg import sql

from .config import Config

# db/0005_jobs.sql sorts before db/0005_state.sql, which is the order the
# Makefile's $(sort) produces and the order the migrations depend on.
MIGRATION_RE = re.compile(r"^\d+.*\.sql$")


def migrations(cfg: Config) -> list[Path]:
    return sorted(
        p for p in cfg.migrations_dir.glob("*.sql") if MIGRATION_RE.match(p.name)
    )


def _quote_literal(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def _substitute(text: str, cfg: Config) -> str:
    """psql's :'name' — the only psql syntax the migrations use."""
    return (
        text.replace(":'authpw'", _quote_literal(cfg.authenticator_password))
        .replace(":'geopw'", _quote_literal(cfg.geoserver_password))
    )


def explain(cfg: Config, err: psycopg.OperationalError) -> str:
    """A wrong password is an ordinary thing to get wrong, not a crash."""
    text = str(err)
    where = f"{cfg.pg_host}:{cfg.pg_port}"
    if "password authentication failed" in text or "no password supplied" in text:
        return (
            f"PostgreSQL at {where} refused the password for user "
            f"{cfg.pg_user!r}.\n"
            "  Use the password you set when you installed PostgreSQL:\n"
            "    Windows:  set PGPASSWORD=yourpassword\n"
            "    macOS/Linux:  export PGPASSWORD=yourpassword\n"
            f"  Or put PGPASSWORD=yourpassword in a .env file at {cfg.repo}.\n"
            "  A different user? Set PGUSER too."
        )
    if "could not connect" in text or "Connection refused" in text or "timeout" in text:
        return (
            f"Nothing is answering on {where}.\n"
            "  Is PostgreSQL running? On Windows it is a service called\n"
            "  postgresql-x64-NN; check it is started. Set PGHOST/PGPORT if it\n"
            "  listens somewhere else."
        )
    return f"Could not reach PostgreSQL at {where}:\n  {text.strip()}"


def database_exists(cfg: Config) -> bool:
    with psycopg.connect(cfg.dsn("postgres"), autocommit=True) as conn:
        row = conn.execute(
            "SELECT 1 FROM pg_database WHERE datname = %s", (cfg.pg_database,)
        ).fetchone()
        return row is not None


def schema_present(cfg: Config) -> bool:
    """Whether the migrations have already been applied here."""
    with psycopg.connect(cfg.dsn(), autocommit=True) as conn:
        row = conn.execute("SELECT to_regclass('public.tile')").fetchone()
        return bool(row and row[0])


def create_database(cfg: Config, *, drop: bool = False) -> None:
    name = sql.Identifier(cfg.pg_database)
    with psycopg.connect(cfg.dsn("postgres"), autocommit=True) as conn:
        if drop:
            conn.execute(sql.SQL("DROP DATABASE IF EXISTS {} WITH (FORCE)").format(name))
        if drop or not database_exists(cfg):
            conn.execute(sql.SQL("CREATE DATABASE {}").format(name))
        # login() signs with this and PostgREST verifies with it; they must agree.
        conn.execute(
            sql.SQL("ALTER DATABASE {} SET app.jwt_secret = {}").format(
                name, sql.Literal(cfg.jwt_secret)
            )
        )


def apply(cfg: Config, *, on_step=print) -> int:
    """Applies every migration in one transaction per file."""
    files = migrations(cfg)
    if not files:
        raise SystemExit(f"no migrations found in {cfg.migrations_dir}")
    with psycopg.connect(cfg.dsn(), autocommit=True) as conn:
        conn.execute("CREATE EXTENSION IF NOT EXISTS postgis")
        conn.execute("CREATE EXTENSION IF NOT EXISTS pgcrypto")
    for path in files:
        on_step(f"  apply {path.name}")
        with psycopg.connect(cfg.dsn()) as conn:
            conn.execute(_substitute(path.read_text(encoding="utf8"), cfg))
            conn.commit()
    return len(files)


def check_postgis(cfg: Config) -> str:
    """Fails early and in words, rather than on the first geometry column."""
    with psycopg.connect(cfg.dsn("postgres"), autocommit=True) as conn:
        row = conn.execute(
            "SELECT default_version FROM pg_available_extensions WHERE name = 'postgis'"
        ).fetchone()
    if not row:
        raise SystemExit(
            "PostGIS is not installed in this PostgreSQL.\n"
            "  Windows: re-run the PostgreSQL installer and tick PostGIS in Stack\n"
            "  Builder at the end. Debian/Ubuntu: apt install postgresql-16-postgis-3."
        )
    return row[0]
