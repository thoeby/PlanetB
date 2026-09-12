"""A database made before the migration ledger existed must still start.

The ledger arrived after the first databases did. Those have the whole schema
and no record of it, so every file looks pending and re-running the first one
that is not written defensively stops the server:

    psycopg.errors.DuplicateObject: constraint "feature_geom_4326_3d" for
    relation "feature" already exists

Needs a PostgreSQL with PostGIS; skipped when there is none.
"""
from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

try:
    import psycopg
except ImportError:  # pragma: no cover - psycopg is the server's one dependency
    psycopg = None

from splatworld import config, migrate  # noqa: E402

TEST_DB = "splatworld_migrate_test"


def reachable() -> bool:
    if psycopg is None:
        return False
    try:
        cfg = config.load({})
        with psycopg.connect(cfg.dsn("postgres"), connect_timeout=5) as conn:
            row = conn.execute("SELECT 1 FROM pg_available_extensions"
                               " WHERE name = 'postgis'").fetchone()
            return bool(row)
    except psycopg.Error:
        return False


@unittest.skipUnless(reachable(), "no PostgreSQL with PostGIS here")
class PreLedgerTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.was = os.environ.get("PGDATABASE")
        os.environ["PGDATABASE"] = TEST_DB
        cls.cfg = config.load({})
        migrate.create_database(cls.cfg, drop=True)
        migrate.apply(cls.cfg, on_step=lambda _: None)

    @classmethod
    def tearDownClass(cls):
        # A throwaway database, and PGDATABASE back to whatever it was: the
        # rest of the suite reads the same environment.
        with psycopg.connect(cls.cfg.dsn("postgres"), autocommit=True) as conn:
            conn.execute(f'DROP DATABASE IF EXISTS "{TEST_DB}" WITH (FORCE)')
        if cls.was is None:
            os.environ.pop("PGDATABASE", None)
        else:
            os.environ["PGDATABASE"] = cls.was

    def test_a_database_with_no_ledger_is_recorded_not_re_run(self):
        with psycopg.connect(self.cfg.dsn(), autocommit=True) as conn:
            conn.execute("DROP TABLE migration")
        files = migrate.migrations(self.cfg)
        # Everything, because nothing here is known to have been applied. It
        # used to be nothing at all, so `splatworld run` applied nothing to a
        # database older than the ledger — for ever, and without saying so.
        self.assertEqual(migrate.pending(self.cfg), [p.name for p in files])
        self.assertEqual(migrate.apply(self.cfg, on_step=lambda _: None), len(files))
        self.assertEqual(migrate.pending(self.cfg), [], "and now it is all recorded")
        with psycopg.connect(self.cfg.dsn(), autocommit=True) as conn:
            kept = conn.execute("SELECT count(*) FROM pg_constraint"
                                " WHERE conname = 'feature_geom_4326_3d'").fetchone()
            self.assertEqual(kept[0], 1, "the schema is untouched by the second pass")

    def test_a_fix_reaches_a_database_that_has_no_ledger(self):
        """The point of all of it: newer SQL lands on an older world."""
        with psycopg.connect(self.cfg.dsn(), autocommit=True) as conn:
            conn.execute("DROP TABLE IF EXISTS migration")
            # As if this database had never had db/0035_mergeready.sql.
            conn.execute("DROP FUNCTION IF EXISTS merge_has_a_child(jsonb)")
        # `splatworld run` applies only what pending() reports, so this is the
        # step that decides whether any of it ever runs.
        self.assertTrue(migrate.pending(self.cfg),
                        "a database with no ledger has everything pending")
        migrate.apply(self.cfg, on_step=lambda _: None)
        with psycopg.connect(self.cfg.dsn(), autocommit=True) as conn:
            back = conn.execute("SELECT to_regprocedure("
                                "'merge_has_a_child(jsonb)')").fetchone()
        self.assertIsNotNone(back[0], "the migration it was missing was applied")


class AlreadyThereTest(unittest.TestCase):
    def test_only_existence_errors_are_forgiven(self):
        class Err(Exception):
            def __init__(self, sqlstate):
                self.sqlstate = sqlstate

        self.assertTrue(migrate.already_there(Err("42710")))   # duplicate_object
        self.assertTrue(migrate.already_there(Err("42P07")))   # duplicate_table
        self.assertFalse(migrate.already_there(Err("42501")))  # insufficient_privilege
        self.assertFalse(migrate.already_there(Err("42601")))  # syntax_error


if __name__ == "__main__":
    unittest.main()
