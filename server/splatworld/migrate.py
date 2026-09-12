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

# Held for the length of an apply, so two `splatworld run` starting together
# cannot both apply the same file. Any constant will do; this one is "splat".
APPLY_LOCK = 0x5350_4C41

# "This object is already there" — what a migration that has already been
# applied says. A database made before the migration ledger existed has the
# schema and no record of it, and these are the errors re-running produces.
ALREADY_THERE = frozenset({
    "42710",  # duplicate_object: a constraint, domain, trigger, role, policy
    "42P07",  # duplicate_table: a table, view, index or sequence
    "42701",  # duplicate_column
    "42P06",  # duplicate_schema
    "42723",  # duplicate_function
    "23505",  # unique_violation: a migration that seeds a row, seeded again
    # And the other half of the same story: a migration that drops what an
    # earlier layout left behind has nothing to drop the second time. A later
    # file having already removed it is exactly the "already applied" case —
    # db/0034 drops the views db/0041 replaced with generated ones.
    "42P01",  # undefined_table: a table or view that is already gone
    "42704",  # undefined_object: a constraint, type or trigger already gone
})


def already_there(err: psycopg.Error) -> bool:
    """Whether the error says the object exists, not that something is wrong."""
    return err.sqlstate in ALREADY_THERE


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
    """Applies the migrations not yet applied here, one transaction per file.

    Which ones those are is recorded in the database itself, so a fix that
    arrives as a new migration is picked up by the next `splatworld run`
    instead of needing `init --reset` — which also deletes the account and
    everything drawn, an unreasonable price for one more table.

    The record is younger than some of the databases it describes: one made
    before it existed has the whole schema and an empty ledger, and re-running
    those files raises "already exists" on the first thing that is not written
    defensively. That is not damage and not a reason to refuse to start, so a
    file whose objects are all already there is recorded as applied rather than
    re-run. Anything else still stops the run.
    """
    files = migrations(cfg)
    if not files:
        raise SystemExit(f"no migrations found in {cfg.migrations_dir}")
    count = 0
    adopted: list[str] = []
    # One applier at a time: two processes that both saw the same file pending
    # would otherwise race, and the loser would stop on the winner's objects.
    with psycopg.connect(cfg.dsn(), autocommit=True) as guard:
        guard.execute("SELECT pg_advisory_lock(%s)", (APPLY_LOCK,))
        guard.execute("CREATE EXTENSION IF NOT EXISTS postgis")
        guard.execute("CREATE EXTENSION IF NOT EXISTS pgcrypto")
        guard.execute("CREATE TABLE IF NOT EXISTS migration"
                      " (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())")
        done = {r[0] for r in guard.execute("SELECT name FROM migration")}
        for path in files:
            if path.name in done:
                continue
            on_step(f"  apply {path.name}")
            if not _apply_one(cfg, path):
                guard.execute("INSERT INTO migration (name) VALUES (%s)"
                              " ON CONFLICT DO NOTHING", (path.name,))
                adopted.append(path.name)
                on_step(f"  {path.name} was already in this database — "
                        "recorded, not re-run")
            count += 1
    # A file is recorded as applied on the first "already exists" it raises, so
    # anything after that statement did not run. For the files an older
    # database already had that is right; say which they were, because a
    # function this leaves at its old definition is a fix that did not land and
    # looks exactly like a fix that did not work.
    if len(adopted) > 2:
        on_step(f"  {len(adopted)} of them were already here and were recorded "
                "rather than re-run. If something still behaves as it did "
                "before, `splatworld init --reset` rebuilds the schema.")
    return count


def _apply_one(cfg: Config, path: Path) -> bool:
    """Applies one file. False if the database already had everything in it."""
    try:
        with psycopg.connect(cfg.dsn()) as conn:
            conn.execute(_substitute(path.read_text(encoding="utf8"), cfg))
            conn.execute("INSERT INTO migration (name) VALUES (%s)", (path.name,))
            conn.commit()
    except psycopg.Error as err:
        if not already_there(err):
            raise
        return False
    return True


def pending(cfg: Config) -> list[str]:
    """Migrations in the checkout that this database has not had.

    A database made before the ledger existed has no record of anything, and
    used to be reported as having nothing pending — so `splatworld run` applied
    nothing to it, ever. Every fix that arrived as SQL went nowhere on exactly
    the worlds that had been running longest, silently, while the Python and
    the client updated around them. A missing ledger means everything is
    pending: apply() records a file whose objects are all already there rather
    than re-running it, so adopting the ledger is safe.
    """
    with psycopg.connect(cfg.dsn(), autocommit=True) as conn:
        if not conn.execute("SELECT to_regclass('public.migration')").fetchone()[0]:
            return [p.name for p in migrations(cfg)]
        done = {r[0] for r in conn.execute("SELECT name FROM migration")}
    return [p.name for p in migrations(cfg) if p.name not in done]


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
