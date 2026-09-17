"""A tile the survey does not reach is no ground, not ground at sea level.

The fill `dem.encode` writes for nodata is 0.0 m, which is right beside real
ground and wrong as a whole tile: client/lib/geo.js reads it back as elevation,
assemble builds a mesh flat at exactly y = 0, and client/atoms/train.js keeps
its splats against a box zero metres high — so a finished training run is
thrown away whole, a quarter of an hour after this was knowable.
"""
from __future__ import annotations

import unittest

import numpy as np

from splatworld import dem


class NoDataIsNotGround(unittest.TestCase):
    def test_a_tile_of_nothing_but_fill_is_no_ground(self):
        empty = dem.encode(np.full((8, 8), np.nan))
        self.assertTrue(dem.all_fill(empty))

    def test_a_tile_with_one_surveyed_sample_is_ground(self):
        values = np.full((8, 8), np.nan)
        values[3, 4] = 1517.6
        self.assertFalse(dem.all_fill(dem.encode(values)))

    def test_a_surveyed_tile_is_ground(self):
        values = np.linspace(600.0, 1218.0, 64).reshape(8, 8)
        self.assertFalse(dem.all_fill(dem.encode(values)))

    def test_the_fill_a_tile_is_judged_on_is_the_one_encode_writes(self):
        empty = dem.decode(dem.encode(np.full((4, 4), np.nan)))
        self.assertTrue(np.all(empty == dem.NODATA_ELEVATION_M))


if __name__ == "__main__":
    unittest.main()
