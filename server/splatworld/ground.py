"""The ground, cut from the world's coverage one tile at a time.

TASKS-usable T1: `/geo/dem/{z}/{x}/{y}.r16` is served on demand. On a miss the
server asks the operator's GeoServer for exactly that tile's bounds at 256²,
encodes dem-v1, stores it, registers the artifact and records which tile it is,
so `geo_inputs()` can pin the elevation a compile actually read (Invariant 2).

Nothing is fetched ahead of time and nothing is fetched twice: a tile is cut
when a browser first walks onto it and is a plain file from then on.
"""
from __future__ import annotations

import hashlib
import os
import threading
from pathlib import Path

import psycopg

from .config import Config
from .importer import DEM_SIZE, _auth_header, fetch, tile_bounds_3857

# Two tabs walking onto the same tile at the same moment must not both cut it.
_cutting: dict[tuple[int, int, int], threading.Lock] = {}
_cutting_guard = threading.Lock()


def _lock(key: tuple[int, int, int]) -> threading.Lock:
    with _cutting_guard:
        return _cutting.setdefault(key, threading.Lock())


def tile_path(cfg: Config, z: int, x: int, y: int) -> Path:
    return cfg.files / "geo" / "dem" / str(z) / str(x) / f"{y}.r16"


def ground_of(conn) -> dict | None:
    row = conn.execute(
        "SELECT geoserver_url, coverage, st_xmin(extent), st_ymin(extent),"
        " st_xmax(extent), st_ymax(extent) FROM ground").fetchone()
    if not row:
        return None
    return {"url": row[0], "coverage": row[1],
            "extent": (row[2], row[3], row[4], row[5])}


def covers(extent: tuple, z: int, x: int, y: int) -> bool:
    """Whether the coverage reaches this tile at all, in lon/lat."""
    from math import atan, degrees, pi, sinh

    n = 2 ** z
    west = x / n * 360 - 180
    east = (x + 1) / n * 360 - 180
    north = degrees(atan(sinh(pi * (1 - 2 * y / n))))
    south = degrees(atan(sinh(pi * (1 - 2 * (y + 1) / n))))
    w, s, e, nth = extent
    return not (east <= w or west >= e or north <= s or south >= nth)


def encode_geotiff(raw: bytes) -> bytes:
    """A GeoTIFF of one tile's box to dem-v1 samples, north-west first."""
    import numpy as np
    import rasterio
    from rasterio.io import MemoryFile

    from . import dem

    with MemoryFile(raw) as memfile, memfile.open() as src:
        band = src.read(1, out_shape=(DEM_SIZE, DEM_SIZE),
                        resampling=rasterio.enums.Resampling.bilinear)
        values = band.astype("float64")
        if src.nodata is not None:
            values = np.where(values == src.nodata, np.nan, values)
        return dem.encode(values)


def cut(cfg: Config, z: int, x: int, y: int) -> Path | None:
    """This tile's elevation as a file, cutting it first if nobody has.

    Returns None when there is no world here: no ground chosen, or the tile is
    outside the coverage. The viewer says so rather than showing a hole.
    """
    from . import geoserver

    target = tile_path(cfg, z, x, y)
    with _lock((z, x, y)):
        if target.is_file():
            return target
        with psycopg.connect(cfg.dsn(), autocommit=True) as conn:
            world = ground_of(conn)
            if not world or not covers(world["extent"], z, x, y):
                return None
            auth = _auth_header(cfg.geoserver_user, cfg.geoserver_admin_password)
            url = geoserver.coverage_tile_url(
                world["url"], world["coverage"], tile_bounds_3857(z, x, y), DEM_SIZE)
            raw = fetch(url, auth, what=f"elevation for {z}/{x}/{y}")
            if not raw:
                return None
            body = encode_geotiff(raw)
            sha = hashlib.sha256(body).hexdigest()
            target.parent.mkdir(parents=True, exist_ok=True)
            # Written beside and moved into place, so a second tab never reads
            # half a tile.
            tmp = target.with_suffix(f".{os.getpid()}.part")
            tmp.write_bytes(body)
            os.replace(tmp, target)
            remember(conn, z, x, y, sha, len(body))
            return target


def remember(conn, z: int, x: int, y: int, sha: str, size: int) -> None:
    """The artifact, and which tile it is the ground for.

    Invariant 1 holds on the bytes: an artifact row is written once and the sha
    is what a job pins. The path is named after the tile rather than the hash
    because that is the address client/lib/geo.js asks for; re-cutting the same
    tile from the same coverage produces the same bytes, and set_ground() clears
    these rows when the coverage changes.
    """
    conn.execute(
        "INSERT INTO artifact (sha256, kind, bytes, algo_version)"
        " VALUES (%s, 'dem', %s, 'dem-v1') ON CONFLICT (sha256) DO NOTHING",
        (sha, size))
    conn.execute(
        "INSERT INTO geo_tile (z, x, y, sha256) VALUES (%s, %s, %s, %s)"
        " ON CONFLICT (z, x, y) DO UPDATE SET sha256 = excluded.sha256,"
        " cut_at = now()", (z, x, y, sha))


def parse_request(path: str) -> tuple[int, int, int] | None:
    """/geo/dem/{z}/{x}/{y}.r16 -> (z, x, y), or None if it is something else."""
    import re

    m = re.fullmatch(r"/geo/dem/(\d+)/(\d+)/(\d+)\.r16", path)
    if not m:
        return None
    z, x, y = (int(v) for v in m.groups())
    if z % 2 or z < 6 or z > 18 or x >= 2 ** z or y >= 2 ** z:
        return None
    return z, x, y
