"""The copies of the tile grid agree, and SQL does not spell a CRS out either.

db/0056 says an EPSG code is spelled in exactly one place per language. It
guards Python (test_crs.py) and JavaScript (client/test/crs.test.js) and left
SQL unguarded, and nothing anywhere checked that the copies still compute the
same grid — they agree today because both are right, not because anything
holds them to it.

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

REPO = Path(__file__).resolve().parent.parent
MIGRATIONS = sorted((REPO / "db").glob("[0-9]*.sql"))

# A geometry column's type needs the number written out — geometry(Polygon,
# 4326) is a typmod, not a choice made at run time, and db/0056 writes one
# itself. So the typmods are taken out first and then *any* bare SRID left in
# the code is drift: every runtime use has world_srid() or tile_srid() to call
# instead. Stripping first, rather than matching the calls that take one, is
# what makes this hold for a call nested inside another.
TYPMOD = re.compile(r"\bgeo(?:metry|graphy)\s*\([^()]*\)", re.IGNORECASE)
BARE_SRID = re.compile(r"\b(?:4326|3857)\b")


def code_of(text: str) -> str:
    """The SQL with its comments, strings and geometry typmods removed.

    A code inside a string is a message to a person ("draw in EPSG:4326"),
    not a choice the code makes, so it comes out with the comments.
    """
    code = "\n".join(line.split("--")[0] for line in text.splitlines())
    code = re.sub(r"/\*.*?\*/", " ", code, flags=re.DOTALL)
    code = re.sub(r"'(?:[^']|'')*'", " ", code)
    # A typmod can hold another: geometry(Polygon, 4326) inside a cast chain.
    for _ in range(3):
        code, n = TYPMOD.subn(" ", code)
        if not n:
            break
    return code


# The migrations that predate the rework, and the one that defines it.
BEFORE_THE_REWORK = 56


def number_of(path: Path) -> int:
    return int(path.name[:4])


class SqlSaysItOnce(unittest.TestCase):
    def test_no_runtime_srid_in_new_migrations(self):
        for path in MIGRATIONS:
            if number_of(path) <= BEFORE_THE_REWORK:
                continue
            code = code_of(path.read_text("utf8"))
            found = BARE_SRID.search(code)
            self.assertIsNone(
                found,
                f"{path.name} spells a CRS out where it runs"
                f" ({found.group(0) if found else ''}). Call world_srid() or"
                " tile_srid() — db/0056_crs.sql defines them once.")


# The functions whose bodies may not name a code; what is left spelling one out
# is fixed when the DDL runs and cannot call anything (the generated `geom`
# column in 0001, the CHECK in 0029, the typmods, 0053's one-time UPDATE).
CATALOG_QUERY = """
SELECT n.nspname || '.' || p.proname, p.prosrc
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname IN ('public', 'api', 'gis', 'auth')
  AND p.proname NOT IN ('world_srid', 'tile_srid')
"""


def dsn() -> str:
    return (f"host={os.environ.get('PGHOST', 'localhost')}"
            f" port={os.environ.get('PGPORT', '5432')}"
            f" user={os.environ.get('PGUSER', 'postgres')}"
            f" password={os.environ.get('PGPASSWORD', 'postgres')}"
            f" dbname={os.environ['PGDATABASE']}")


@unittest.skipUnless(os.environ.get("PGDATABASE"), "no database in the environment")
class TheAppliedSchemaSaysItOnce(unittest.TestCase):
    """Not one function body in the world that runs names an EPSG code.

    The file-by-file check above only covers migrations written after the
    rework; this covers what a reset actually leaves behind, which is the
    thing that computes (db/0060_crssaysitonce.sql).
    """

    def test_no_function_body_names_a_code(self):
        import psycopg

        with psycopg.connect(dsn(), connect_timeout=5) as conn:
            named = [name for name, body in conn.execute(CATALOG_QUERY)
                     if BARE_SRID.search(code_of(body))]
        self.assertEqual(
            named, [],
            "these applied function bodies spell a CRS out: call world_srid()"
            " or tile_srid() instead, in a new migration.")


@unittest.skipUnless(os.environ.get("PGDATABASE"), "no database in the environment")
class CopiesAgree(unittest.TestCase):
    """tile_bbox_merc() in SQL and crs.tile_bounds() in Python are one grid."""

    TILES = ((0, 0, 0), (6, 33, 22), (10, 534, 358), (14, 8551, 5810), (18, 137000, 92000))

    def test_the_grids_are_the_same(self):
        import psycopg

        with psycopg.connect(dsn(), connect_timeout=5) as conn:
            self.assertEqual(
                conn.execute("SELECT world_srid(), tile_srid()").fetchone(),
                (crs.WORLD_SRID, crs.TILE_SRID),
                "the SRIDs SQL and Python name are not the same pair")
            for z, x, y in self.TILES:
                got = conn.execute(
                    "SELECT st_xmin(g), st_ymin(g), st_xmax(g), st_ymax(g)"
                    " FROM (SELECT tile_bbox_merc(%s, %s, %s) AS g) q",
                    (z, x, y)).fetchone()
                want = crs.tile_bounds(z, x, y)
                for a, b, axis in zip(got, want, "west south east north".split()):
                    self.assertAlmostEqual(
                        a, b, places=6,
                        msg=f"{z}/{x}/{y} {axis}: SQL {a} vs Python {b}")


if __name__ == "__main__":
    unittest.main()
