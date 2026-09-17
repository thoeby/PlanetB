"""Ground-cover layers for tools/geoserver-fixture.py.

TASKS-foundation.md FND.0 and FND.12. A cover source reaches the world as a
**class raster** over WMS, exactly as the albedo does (PLAN-foundation.md §6):
a raster source (ESA WorldCover) already is one, and a vector source
(swissTLM3D, OSM) is one the operator publishes with a style that paints every
class in its own colour. This does both, over the two fixtures
`tools/make-seed-cover.sh` writes, so that the stories have cover to map.

**The class style** — the one FND.12's downloadable SLD has to reproduce — is
a colour per class code, injective and fixed:

    r = code
    g = (code * 73 + 41) & 0xFF
    b = (code * 151 + 97) & 0xFF

Injective in `code`, so a page that reads the PNG back gets the class it asked
for, and far enough apart in hue that an admin looking at the map preview can
tell forest from rock. Nothing here interprets a class: the codes are the
source's own, and what each one *means* is the admin's mapping table.
"""
from __future__ import annotations

import os
import sqlite3
import struct
import subprocess
import tempfile
import zlib

import numpy as np
import rasterio
from rasterio.transform import from_bounds
from rasterio.vrt import WarpedVRT

# 2 m over the fixture's 4 km: finer than the z18 cell the compiler samples at.
RASTERIZE_M = 2.0


def colour_of(code: int) -> tuple:
    return (code & 0xFF, (code * 73 + 41) & 0xFF, (code * 151 + 97) & 0xFF)


def png(rgba: np.ndarray) -> bytes:
    """An RGBA numpy array (h, w, 4) as a PNG. No filtering, no interlacing.

    Alpha, not a colour, says "no class here": a cover source lower in
    priority fills where the one above it is transparent (PLAN §6), and that
    is a pixel copy, not an interpretation.
    """
    height, width = rgba.shape[0], rgba.shape[1]
    rows = b"".join(b"\x00" + rgba[r].tobytes() for r in range(height))

    def chunk(kind: bytes, data: bytes) -> bytes:
        return (struct.pack(">I", len(data)) + kind + data
                + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF))

    head = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", head)
            + chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b""))


def _distinct(gpkg: str, table: str, field: str) -> list:
    """The classes in a GeoPackage, read as SQLite reads them: sorted, stable."""
    with sqlite3.connect(gpkg) as db:
        rows = db.execute(
            f'SELECT DISTINCT "{field}" FROM "{table}" '
            f'WHERE "{field}" IS NOT NULL ORDER BY 1').fetchall()
    return [r[0] for r in rows]


def _extent(gpkg: str, table: str) -> tuple:
    with sqlite3.connect(gpkg) as db:
        row = db.execute(
            'SELECT min_x, min_y, max_x, max_y FROM gpkg_contents '
            'WHERE table_name = ?', (table,)).fetchone()
    if not row:
        raise SystemExit(f'geoserver_cover: {gpkg} has no layer {table}')
    return tuple(float(v) for v in row)


def rasterize(gpkg: str, table: str, field: str, into: str) -> dict:
    """Burn a vector class layer into a Byte GeoTIFF, one code per class.

    This is the operator's job in the real world — publish the vector with a
    class style — done once here with GDAL's own tools, so that the fixture
    answers GetMap from a raster like every other cover source.
    """
    west, south, east, north = _extent(gpkg, table)
    mid = (south + north) / 2
    m_lon = 111320.0 * np.cos(np.radians(mid))
    width = max(1, int(round((east - west) * m_lon / RASTERIZE_M)))
    height = max(1, int(round((north - south) * 111320.0 / RASTERIZE_M)))
    subprocess.run(
        ['gdal_create', '-q', '-outsize', str(width), str(height), '-ot', 'Byte',
         '-a_srs', 'EPSG:4326', '-a_ullr', str(west), str(north), str(east),
         str(south), '-burn', '0', into], check=True)
    classes = {}
    for code, value in enumerate(_distinct(gpkg, table, field), start=1):
        classes[str(value)] = code
        subprocess.run(
            ['gdal_rasterize', '-q', '-burn', str(code), '-l', table,
             '-where', f'"{field}" = \'{value}\'', gpkg, into], check=True)
    return classes


class Cover:
    """One cover layer, always a class raster by the time it is asked for."""

    def __init__(self, name: str, path: str, field: str | None = None,
                 label: str | None = None):
        self.name = name
        self.label = label or name
        self._tmp = None
        self.classes = {}
        if path.endswith('.gpkg'):
            table = os.environ.get('COVER_TABLE') or _first_table(path)
            self._tmp = tempfile.NamedTemporaryFile(suffix='.tif', delete=False)
            self._tmp.close()
            self.classes = rasterize(path, table, field or 'OBJEKTART',
                                     self._tmp.name)
            self.path = self._tmp.name
        else:
            self.path = path
        with rasterio.open(self.path) as src:
            self.bounds = tuple(src.bounds)

    def class_png(self, bbox: tuple, crs_name: str, width: int, height: int) -> bytes:
        """The window, painted by the class style. Nearest: a class is not a mean."""
        with rasterio.open(self.path) as src, WarpedVRT(
                src, crs=crs_name,
                transform=from_bounds(*bbox, width, height),
                width=width, height=height,
                resampling=rasterio.enums.Resampling.nearest) as vrt:
            codes = vrt.read(1).astype('uint16')
        lut = np.zeros((256, 4), dtype='uint8')
        for code in range(1, 256):
            lut[code] = (*colour_of(code), 255)
        return png(lut[np.clip(codes, 0, 255)])

    def close(self) -> None:
        if self._tmp:
            os.unlink(self._tmp.name)
            self._tmp = None


def _first_table(gpkg: str) -> str:
    with sqlite3.connect(gpkg) as db:
        row = db.execute("SELECT table_name FROM gpkg_contents "
                         "WHERE data_type = 'features' ORDER BY table_name").fetchone()
    if not row:
        raise SystemExit(f'geoserver_cover: {gpkg} holds no feature layer')
    return row[0]
