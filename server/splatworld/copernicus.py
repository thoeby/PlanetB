"""Free elevation for anywhere on land, so a world needs no data of your own.

Copernicus GLO-30 is a 30 m global DSM published as Cloud-Optimized GeoTIFFs on
AWS open data — no account, no key, no download of the whole thing: GDAL reads
the few kilobytes it needs over HTTP range requests. One file per 1° cell.

tools/seed-dem.sh reads the same source; this is the same idea without the shell.
"""
from __future__ import annotations

import math
from pathlib import Path

import rasterio
from rasterio.merge import merge

BASE = "https://copernicus-dem-30m.s3.amazonaws.com"


def cell_name(lat: int, lon: int) -> str:
    """Copernicus names a cell by the corner it starts at, always zero-padded."""
    ns = f"{'N' if lat >= 0 else 'S'}{abs(lat):02d}"
    ew = f"{'E' if lon >= 0 else 'W'}{abs(lon):03d}"
    return f"Copernicus_DSM_COG_10_{ns}_00_{ew}_00_DEM"


def cells_for(bbox: list[float]) -> list[str]:
    """Every 1° cell a lon/lat box touches."""
    west, south, east, north = bbox
    out = []
    for lat in range(math.floor(south), math.floor(north) + 1):
        for lon in range(math.floor(west), math.floor(east) + 1):
            out.append(cell_name(lat, lon))
    return out


def url_for(cell: str) -> str:
    # /vsicurl/ is GDAL's "read this over HTTP without downloading it".
    return f"/vsicurl/{BASE}/{cell}/{cell}.tif"


def mosaic(bbox: list[float], target: Path, on_step=lambda *_: None) -> Path:
    """Writes the bbox's elevation to one GeoTIFF, from as many cells as it spans.

    Only the window that is wanted is read, so a small region costs a few
    hundred kilobytes however large the cells are.
    """
    opened, missing = [], []
    for cell in cells_for(bbox):
        on_step(f"  elevation: {cell}")
        try:
            opened.append(rasterio.open(url_for(cell)))
        except rasterio.errors.RasterioIOError:
            # Cells that are all sea are not published at all.
            missing.append(cell)
    if not opened:
        raise SystemExit(
            "import: no Copernicus elevation covers that area.\n"
            f"  Tried: {', '.join(missing) or 'nothing'}\n"
            "  Cells that are entirely sea are not published. Pick somewhere on land,\n"
            "  or give a GeoTIFF of your own."
        )
    try:
        data, transform = merge(opened, bounds=tuple(bbox))
        profile = opened[0].profile | {
            "driver": "GTiff", "height": data.shape[1], "width": data.shape[2],
            "count": 1, "transform": transform,
        }
        with rasterio.open(target, "w", **profile) as dst:
            dst.write(data[0], 1)
    finally:
        for src in opened:
            src.close()
    return target
