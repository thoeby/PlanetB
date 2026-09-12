"""Cuts elevation into the dem-v1 tiles the compiler reads.

One tile is 256x256 uint16 samples, row-major, north-west first, in the tile
projection (crs.TILE) over exactly the tile's bounds, with `elevation_m = value * 0.2 - 500`. That is
what tools/seed-dem.sh produces with gdalwarp, and what client/lib/geo.js reads
back; this does the same with rasterio so nothing has to be installed by hand.

rasterio's wheels carry their own GDAL, which is the whole reason it is here.
"""
from __future__ import annotations

import hashlib
from pathlib import Path

import numpy as np
import rasterio
from rasterio.transform import from_bounds
from rasterio.warp import Resampling, reproject

from . import crs
from .importer import DEM_MAX, DEM_MIN, DEM_SIZE

# Ground with no data becomes sea level rather than a hole: the terrain mesh has
# to be continuous, and a NaN would travel into every vertex that samples it.
NODATA_ELEVATION_M = 0.0


def encode(elevation_m: np.ndarray) -> bytes:
    """Metres to dem-v1 samples: a linear map of [-500, 12607] onto uint16."""
    filled = np.where(np.isfinite(elevation_m), elevation_m, NODATA_ELEVATION_M)
    clipped = np.clip(filled, DEM_MIN, DEM_MAX)
    scaled = (clipped - DEM_MIN) * (65535.0 / (DEM_MAX - DEM_MIN))
    return np.rint(scaled).astype("<u2").tobytes()


def decode(raw: bytes) -> np.ndarray:
    """The inverse, for tests and for reading a tile back."""
    samples = np.frombuffer(raw, dtype="<u2").astype("float64")
    return samples * 0.2 - 500.0


def cut_tile(src, z: int, x: int, y: int) -> bytes:
    """One tile, reprojected and resampled to its own bounds."""
    west, south, east, north = crs.tile_bounds(z, x, y)
    destination = np.full((DEM_SIZE, DEM_SIZE), np.nan, dtype="float32")
    reproject(
        source=rasterio.band(src, 1),
        destination=destination,
        src_transform=src.transform,
        src_crs=src.crs,
        src_nodata=src.nodata,
        dst_transform=from_bounds(west, south, east, north, DEM_SIZE, DEM_SIZE),
        dst_crs=crs.TILE,
        dst_nodata=float("nan"),
        resampling=Resampling.cubic,
    )
    return encode(destination)


def covers(src, tiles: list[tuple[int, int, int]]) -> list[tuple[int, int, int]]:
    """Tiles the source has no data for at all, so the caller can say so."""
    from rasterio.warp import transform_bounds

    west, south, east, north = transform_bounds(src.crs, crs.TILE, *src.bounds)
    missing = []
    for z, x, y in tiles:
        tw, ts, te, tn = crs.tile_bounds(z, x, y)
        if te <= west or tw >= east or tn <= south or ts >= north:
            missing.append((z, x, y))
    return missing


def place(path: Path, payload: bytes) -> None:
    """Invariant 1: a store path is written once.

    A re-cut may land only when it reproduces the bytes already there; different
    bytes are an error rather than an overwrite, because /geo is served
    immutable. Same rule as geo_place() in tools/geo-common.sh.
    """
    if path.exists() and path.stat().st_size:
        if path.read_bytes() != payload:
            raise SystemExit(
                f"import: {path} is already there with different bytes.\n"
                "  A seeded tile is immutable. Delete it if you meant to re-cut it."
            )
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(payload)


def cut(source: Path, files_root: Path, tiles: list[tuple[int, int, int]],
        on_step=lambda *_: None) -> tuple[list[tuple[str, int]], list[tuple[int, int, int]]]:
    """Cuts every tile.

    Returns (sha256, bytes) for each written tile — what register_artifact
    needs — and the tiles the source has no data for at all, which the caller
    reports: a world whose elevation misses half its region is a mistake worth
    hearing about, not a silent plain at sea level.
    """
    written: list[tuple[str, int]] = []
    with rasterio.open(source) as src:
        if src.crs is None:
            raise SystemExit(
                f"import: {source} has no coordinate system, so it cannot be "
                f"placed on the earth. Export it with one ({crs.WORLD} or {crs.TILE})."
            )
        blank = covers(src, tiles)
        for index, (z, x, y) in enumerate(tiles, 1):
            payload = cut_tile(src, z, x, y)
            path = files_root / "geo" / "dem" / str(z) / str(x) / f"{y}.r16"
            place(path, payload)
            written.append((hashlib.sha256(payload).hexdigest(), len(payload)))
            on_step(index, len(tiles), z, x, y)
    return written, blank
