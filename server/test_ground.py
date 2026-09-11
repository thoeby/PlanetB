"""Cutting the ground out of a coverage, one tile at a time (TASKS-usable T1).

The GeoServer is a stub here: eight lines of http.server handing back a GeoTIFF
for whatever box is asked for. What is being tested is ours — that the request
names the tile's own bounds, that the answer becomes dem-v1 the compiler can
read, and that a tile outside the coverage is no world rather than a hole.
"""
from __future__ import annotations

import http.server
import threading
from pathlib import Path

import numpy as np
import pytest
import rasterio
from rasterio.io import MemoryFile
from rasterio.transform import from_bounds

from splatworld import dem, ground
from splatworld.config import Config

SWISS = (7.9, 47.3, 8.2, 47.5)


def geotiff(bounds, size=256, value=1234.0) -> bytes:
    """A GeoTIFF of one box, every sample the same height."""
    west, south, east, north = bounds
    data = np.full((size, size), value, dtype="float32")
    with MemoryFile() as memfile:
        with memfile.open(driver="GTiff", width=size, height=size, count=1,
                          dtype="float32", crs="EPSG:3857",
                          transform=from_bounds(west, south, east, north, size, size),
                          nodata=-9999.0) as dst:
            dst.write(data, 1)
        return memfile.read()


class Stub(http.server.BaseHTTPRequestHandler):
    asked: list[str] = []

    def do_GET(self):  # noqa: N802 - stdlib name
        Stub.asked.append(self.path)
        body = geotiff((0, 0, 1, 1))
        self.send_response(200)
        self.send_header("Content-Type", "image/tiff")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):  # noqa: A003 - quiet
        pass


@pytest.fixture()
def wcs():
    server = http.server.HTTPServer(("127.0.0.1", 0), Stub)
    Stub.asked = []
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{server.server_port}/geoserver"
    server.shutdown()


def test_a_tile_outside_the_coverage_is_not_world():
    # Zürich is inside; Cairo is not.
    assert ground.covers(SWISS, 14, 8557, 5736)
    assert not ground.covers(SWISS, 14, 9700, 7000)


def test_the_request_names_a_tile_not_a_coverage(wcs):
    from splatworld import geoserver
    from splatworld.importer import tile_bounds_3857

    url = geoserver.coverage_tile_url(wcs, "ch:alti", tile_bounds_3857(14, 8557, 5736), 256)
    assert "WIDTH=256" in url and "HEIGHT=256" in url
    assert "BBOX=" in url and "version=1.0.0" in url
    # The box is the tile's own, in metres, not the whole country.
    west = float(url.split("BBOX=")[1].split("%2C")[0])
    assert 800000 < west < 1000000


def test_a_geotiff_becomes_ground_the_compiler_can_read():
    raw = geotiff((0, 0, 1, 1), value=1234.0)
    body = ground.encode_geotiff(raw)
    assert len(body) == 256 * 256 * 2
    metres = dem.decode(body)
    assert abs(metres.mean() - 1234.0) < 0.2       # dem-v1 quantises to 0.2 m


def test_nodata_becomes_sea_level_not_a_hole():
    raw = geotiff((0, 0, 1, 1), value=-9999.0)     # the stub's nodata value
    metres = dem.decode(ground.encode_geotiff(raw))
    assert abs(metres.mean()) < 0.2


def test_parse_request_takes_only_tiles_that_exist():
    assert ground.parse_request("/geo/dem/14/8557/5736.r16") == (14, 8557, 5736)
    assert ground.parse_request("/geo/dem/13/1/1.r16") is None     # odd zoom
    assert ground.parse_request("/geo/dem/14/99999999/1.r16") is None
    assert ground.parse_request("/geo/ortho/14/1/1.webp") is None
    assert ground.parse_request("/tiles/14/1/1/abc.sog") is None


def test_the_cut_is_written_once_and_reused(wcs, tmp_path: Path, monkeypatch):
    """Two tabs walking onto the same tile ask GeoServer once."""
    cfg = Config(files_root=tmp_path)
    monkeypatch.setattr(ground, "ground_of", lambda conn: {
        "url": wcs, "coverage": "ch:alti", "extent": SWISS})
    monkeypatch.setattr(ground, "remember", lambda *a, **k: None)

    class NoDatabase:
        def __enter__(self): return self
        def __exit__(self, *a): return False

    monkeypatch.setattr(ground.psycopg, "connect", lambda *a, **k: NoDatabase())

    first = ground.cut(cfg, 14, 8557, 5736)
    assert first and first.is_file()
    assert first.stat().st_size == 256 * 256 * 2
    asked = len(Stub.asked)
    again = ground.cut(cfg, 14, 8557, 5736)
    assert again == first
    assert len(Stub.asked) == asked, "a cut tile is a file, not another request"


def test_outside_the_coverage_nothing_is_cut(wcs, tmp_path: Path, monkeypatch):
    cfg = Config(files_root=tmp_path)
    monkeypatch.setattr(ground, "ground_of", lambda conn: {
        "url": wcs, "coverage": "ch:alti", "extent": SWISS})

    class NoDatabase:
        def __enter__(self): return self
        def __exit__(self, *a): return False

    monkeypatch.setattr(ground.psycopg, "connect", lambda *a, **k: NoDatabase())
    assert ground.cut(cfg, 14, 9700, 7000) is None
