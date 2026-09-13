"""The edge of a coverage, and what the world says when a tile is past it.

A tile at z10 is twenty-seven kilometres across and an operator's coverage is
often four. Asked for ground it has not got, a WCS answers with a 500 and an
exception report — not with an empty raster — and until this the whole world
read that as "your elevation service is broken" and put it on the screen.
"""
from __future__ import annotations

import unittest
import xml.etree.ElementTree as ET

from splatworld import crs
from splatworld.geoserver import corners

ENVELOPE = """<gml:Envelope xmlns:gml="http://www.opengis.net/gml/3.2"
    srsName="http://www.opengis.net/def/crs/EPSG/0/2056" axisLabels="E N">
  <gml:lowerCorner>2630000.0 1126000.0</gml:lowerCorner>
  <gml:upperCorner>2634000.0 1130000.0</gml:upperCorner>
</gml:Envelope>"""


class CoverageEdge(unittest.TestCase):
    def test_corners_are_read_in_the_order_they_are_written(self):
        self.assertEqual(corners(ET.fromstring(ENVELOPE)),
                         (2630000.0, 1126000.0, 2634000.0, 1130000.0))

    def test_an_envelope_with_no_corners_is_no_answer(self):
        bare = ET.fromstring('<gml:Envelope xmlns:gml="http://www.opengis.net/gml/3.2"'
                             ' axisLabels="E N"/>')
        self.assertIsNone(corners(bare))

    def test_corners_that_are_not_numbers_are_no_answer(self):
        odd = ET.fromstring(ENVELOPE.replace("2630000.0", "somewhere"))
        self.assertIsNone(corners(odd))

    def test_a_tile_inside_the_coverage_is_asked_for_as_it_is(self):
        box = (2631000.0, 1127000.0, 2632000.0, 1128000.0)
        self.assertEqual(crs.clip(box, corners(ET.fromstring(ENVELOPE))), box)

    def test_a_tile_that_hangs_over_the_edge_is_cut_down_to_it(self):
        wide = (2620000.0, 1120000.0, 2640000.0, 1140000.0)
        self.assertEqual(crs.clip(wide, corners(ET.fromstring(ENVELOPE))),
                         (2630000.0, 1126000.0, 2634000.0, 1130000.0))

    def test_a_tile_past_the_edge_is_nothing_rather_than_a_smaller_box(self):
        far = (2700000.0, 1200000.0, 2710000.0, 1210000.0)
        self.assertIsNone(crs.clip(far, corners(ET.fromstring(ENVELOPE))))

    def test_a_box_that_only_touches_the_edge_is_nothing_too(self):
        touching = (2634000.0, 1126000.0, 2640000.0, 1130000.0)
        self.assertIsNone(crs.clip(touching, corners(ET.fromstring(ENVELOPE))))

    def test_lon_lat_becomes_the_tile_projection_the_same_way_round(self):
        west, south, east, north = crs.merc_box((7.85, 46.27, 7.91, 46.31))
        self.assertLess(west, east)
        self.assertLess(south, north)
        # Visp is a little east of the prime meridian and well north of it.
        self.assertGreater(west, 0)
        self.assertGreater(south, 5_000_000)


if __name__ == "__main__":
    unittest.main()
