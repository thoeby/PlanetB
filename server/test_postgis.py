"""Layers that are already tables here are offered like any other layer.

A list to pick from, not a path to type: the tables in the database this
server already talks to, with their columns, so the import page can map a
column to a property the compiler reads. Needs a PostgreSQL with PostGIS;
skipped when there is none.
"""
from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

try:
    import psycopg
except ImportError:  # pragma: no cover
    psycopg = None

from splatworld import config, migrate, postgis  # noqa: E402

TEST_DB = "splatworld_postgis_test"


def reachable() -> bool:
    if psycopg is None:
        return False
    try:
        with psycopg.connect(config.load({}).dsn("postgres"), connect_timeout=5) as conn:
            return bool(conn.execute("SELECT 1 FROM pg_available_extensions"
                                     " WHERE name = 'postgis'").fetchone())
    except psycopg.Error:
        return False


@unittest.skipUnless(reachable(), "no PostgreSQL with PostGIS here")
class LayersTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.was = os.environ.get("PGDATABASE")
        os.environ["PGDATABASE"] = TEST_DB
        cls.cfg = config.load({})
        migrate.create_database(cls.cfg, drop=True)
        migrate.apply(cls.cfg, on_step=lambda _: None)
        with psycopg.connect(cls.cfg.dsn(), autocommit=True) as conn:
            conn.execute("CREATE TABLE stands (gid serial PRIMARY KEY, baumart text,"
                         " alter_j numeric, geom geometry(Polygon, 2056))")
            conn.execute(
                "INSERT INTO stands (baumart, alter_j, geom) VALUES ('Fichte', 35,"
                " st_transform(st_setsrid(st_makeenvelope(8.04, 47.39, 8.05, 47.40),"
                " 4326), 2056))")

    @classmethod
    def tearDownClass(cls):
        with psycopg.connect(cls.cfg.dsn("postgres"), autocommit=True) as conn:
            conn.execute(f'DROP DATABASE IF EXISTS "{TEST_DB}" WITH (FORCE)')
        if cls.was is None:
            os.environ.pop("PGDATABASE", None)
        else:
            os.environ["PGDATABASE"] = cls.was

    def test_the_world_is_not_a_layer_to_import_into_itself(self):
        names = [layer["name"] for layer in postgis.layers(self.cfg)]
        self.assertIn("public.stands", names)
        for ours in ("public.area", "public.feature", "public.instance", "public.tile"):
            self.assertNotIn(ours, names)

    def test_a_layer_carries_its_columns_and_its_extent(self):
        layer = next(l for l in postgis.layers(self.cfg) if l["name"] == "public.stands")
        self.assertEqual(layer["fields"], ["gid", "baumart", "alter_j"],
                         "the columns are what a mapping points at")
        self.assertAlmostEqual(layer["bbox"][0], 8.04, places=2)
        self.assertAlmostEqual(layer["bbox"][3], 47.40, places=2)

    def test_it_reads_back_as_geojson_in_degrees(self):
        out = postgis.as_geojson(self.cfg, {"name": "stands", "table": "public.stands"})
        self.assertEqual(out["type"], "FeatureCollection")
        self.assertEqual(len(out["features"]), 1)
        feature = out["features"][0]
        self.assertEqual(feature["properties"]["baumart"], "Fichte",
                         "the columns come through for the property mapping")
        self.assertNotIn("geom", feature["properties"], "the geometry is not a property")
        lon, lat = feature["geometry"]["coordinates"][0][0]
        self.assertAlmostEqual(lon, 8.04, places=2, msg="reprojected from 2056")
        self.assertAlmostEqual(lat, 47.39, places=2)


if __name__ == "__main__":
    unittest.main()


class WfsUrlTest(unittest.TestCase):
    """Whatever the address is, GetFeature is asked of the WFS endpoint.

    Typing the root and getting GeoServer's admin page back as "that was not
    GeoJSON" is the whole reason this is a test.
    """

    def test_every_shape_of_address_reaches_wfs(self):
        from splatworld.importer import wfs_url

        for typed in ("localhost:8081/geoserver",
                      "http://localhost:8081/geoserver/",
                      "http://localhost:8081/geoserver/wfs",
                      "http://localhost:8081/geoserver/wfs?service=WFS&request=GetCapabilities"):
            got = wfs_url(typed, "splatworld:feature_footprint", None)
            self.assertTrue(got.startswith("http://localhost:8081/geoserver/wfs?"), got)
            self.assertIn("request=GetFeature", got)

    def test_a_workspace_address_keeps_its_workspace(self):
        from splatworld.importer import wfs_url

        got = wfs_url("http://h/geoserver/myws", "myws:roads", None)
        self.assertTrue(got.startswith("http://h/geoserver/myws/wfs?"), got)
