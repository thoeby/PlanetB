"""The coordinate systems are defined once, and the copies agree.

    python -m unittest discover -s server -p 'test_*.py'
"""
from __future__ import annotations

import os
import re
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from splatworld import crs  # noqa: E402

PACKAGE = Path(__file__).resolve().parent / "splatworld"
# An EPSG code, or a bare SRID where PostGIS takes one.
STRAY = re.compile(r"EPSG[:\"]\s*\d|\b(?:4326|3857)\b")


class Copies(unittest.TestCase):
    def test_no_epsg_code_outside_crs_py(self):
        for path in sorted(PACKAGE.glob("*.py")):
            if path.name == "crs.py":
                continue
            for number, line in enumerate(path.read_text("utf8").splitlines(), 1):
                self.assertIsNone(STRAY.search(line),
                                  f"{path.name}:{number} spells a CRS out: {line.strip()}")

    def test_z0_is_the_mercator_square(self):
        r = crs.MERC_R
        self.assertEqual(crs.tile_bounds(0, 0, 0), (-r, -r, r, r))

    def test_tile_bounds_nest(self):
        w, s, e, n = crs.tile_bounds(10, 534, 358)
        for dx in (0, 1):
            for dy in (0, 1):
                cw, cs, ce, cn = crs.tile_bounds(11, 534 * 2 + dx, 358 * 2 + dy)
                self.assertGreaterEqual(cw, w - 1e-6)
                self.assertLessEqual(ce, e + 1e-6)
                self.assertGreaterEqual(cs, s - 1e-6)
                self.assertLessEqual(cn, n + 1e-6)


class AgreesWithTheDatabase(unittest.TestCase):
    """Skips without a database; `make api-test` has one."""

    def setUp(self):
        try:
            import psycopg
            self.conn = psycopg.connect(
                host=os.environ.get("PGHOST", "localhost"),
                port=os.environ.get("PGPORT", "5432"),
                user=os.environ.get("PGUSER", "postgres"),
                password=os.environ.get("PGPASSWORD", "postgres"),
                dbname=os.environ.get("PGDATABASE", "splatworld"),
                connect_timeout=3)
        except Exception as err:  # noqa: BLE001
            self.skipTest(f"no database: {err}")

    def tearDown(self):
        self.conn.close()

    def test_srids(self):
        world, tile = self.conn.execute("SELECT world_srid(), tile_srid()").fetchone()
        self.assertEqual((world, tile), (crs.WORLD_SRID, crs.TILE_SRID))

    def test_tile_bounds(self):
        for z, x, y in ((0, 0, 0), (10, 534, 358), (18, 136900, 91700)):
            row = self.conn.execute(
                "SELECT st_xmin(b), st_ymin(b), st_xmax(b), st_ymax(b)"
                " FROM tile_bbox_merc(%s::int, %s::int, %s::int) AS b", (z, x, y)).fetchone()
            for ours, theirs in zip(crs.tile_bounds(z, x, y), row):
                self.assertAlmostEqual(ours, theirs, places=6)


if __name__ == "__main__":
    unittest.main()
