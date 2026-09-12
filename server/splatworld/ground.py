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


# A GeoTIFF begins "II*\0" (little-endian), "MM\0*" (big-endian), or their
# BigTIFF forms. Anything else is not a raster.
TIFF_MAGIC = (b"II*\x00", b"MM\x00*", b"II+\x00", b"MM\x00+")


def not_a_raster(raw: bytes) -> str | None:
    """What the server said instead of a coverage, if it is not one.

    An OGC service reports a refusal as an XML exception with a 200, so bytes
    came back and rasterio was handed them: "not recognized as being in a
    supported file format" is GeoServer's complaint, unread.
    """
    if raw[:4] in TIFF_MAGIC:
        return None
    from . import geoserver

    try:
        import xml.etree.ElementTree as ET

        said = geoserver.exception_text(ET.fromstring(raw))
        if said:
            return said.strip()
    except Exception:  # noqa: BLE001 - not XML either, then; show what it is
        pass
    return raw[:300].decode("utf8", "replace").replace("\n", " ").strip()


def encode_geotiff(raw: bytes, bounds: tuple | None = None) -> bytes:
    """A GeoTIFF to dem-v1 samples of one tile's box, north-west first.

    `bounds` is the tile in EPSG:3857. The coverage is asked for in its own CRS
    — a Swiss DEM is LV95, and asking GeoServer to reproject as well is one more
    thing that can be refused — so what comes back is warped here, onto exactly
    the box the tile is.
    """
    import numpy as np
    import rasterio
    from rasterio.io import MemoryFile
    from rasterio.vrt import WarpedVRT

    from . import dem

    with MemoryFile(raw) as memfile, memfile.open() as src:
        if bounds is None or src.crs is None:
            band = src.read(1, out_shape=(DEM_SIZE, DEM_SIZE),
                            resampling=rasterio.enums.Resampling.bilinear)
        else:
            west, south, east, north = bounds
            with WarpedVRT(src, crs="EPSG:3857",
                           transform=rasterio.transform.from_bounds(
                               west, south, east, north, DEM_SIZE, DEM_SIZE),
                           width=DEM_SIZE, height=DEM_SIZE,
                           resampling=rasterio.enums.Resampling.bilinear) as vrt:
                band = vrt.read(1)
        values = band.astype("float64")
        if src.nodata is not None:
            values = np.where(values == src.nodata, np.nan, values)
        return dem.encode(values)


def native_bounds(crs: str | None, bounds: tuple) -> tuple:
    """The tile's box in the coverage's own CRS."""
    if not crs:
        return bounds
    from rasterio.warp import transform_bounds

    target = crs if ":" in str(crs) else f"EPSG:{crs}"
    return tuple(transform_bounds("EPSG:3857", target, *bounds))


def _said(text: str) -> str:
    """A failure from fetch(), with any OGC exception in it read.

    An HTTP error carries the body, and the body is an ExceptionReport: what
    matters is the code and the sentence in it, not four hundred characters of
    namespace declarations.
    """
    start = text.find("<?xml")
    if start < 0:
        start = text.find("<ows:ExceptionReport")
    if start < 0:
        return text
    from . import geoserver

    head = text[:start].strip()
    try:
        import xml.etree.ElementTree as ET

        root = ET.fromstring(text[start:])
    except Exception:  # noqa: BLE001 - truncated or not XML after all
        return text
    code = ""
    for node in root.iter():
        if geoserver.local(node.tag) == "Exception":
            code = node.get("exceptionCode") or ""
            break
    words = geoserver.exception_text(root) or ""
    return " ".join(p for p in (head, code, words.strip()) if p)


def _ask(world: dict, bounds: tuple, auth: dict, at: str) -> tuple[bytes, str]:
    """The coverage for one tile, in whichever WCS version answers with one.

    1.0.0 first: it takes a plain BBOX and needs nothing to be named. An
    installation with 1.0.0 switched off answers "Could not understand
    version:1.0.0", which is not a reason to give up on the tile — so the
    others are tried, and only if none of them returns a raster is the failure
    reported, with what each one said.
    """
    from . import geoserver

    said: list[str] = []
    for version, name in [(v, n) for v in ("1.0.0", "2.0.1", "1.1.1")
                          for n in geoserver.spellings(world["coverage"])]:
        box, axes = bounds, None
        if version == "2.0.1":
            # What this coverage calls its axes, and the box in its own CRS.
            try:
                about = geoserver.describe_coverage(world["url"], name, auth)
            except SystemExit as err:
                said.append(f"WCS {version} as {name!r}: {_said(str(err))}")
                continue
            axes = tuple(about["axes"])
            box = native_bounds(about["crs"], bounds)
            world.setdefault("native", {})[version] = box
        url = geoserver.coverage_tile_url(
            world["url"], name, box, DEM_SIZE, version=version, axes=axes)
        try:
            raw = fetch(url, auth, what=f"elevation for {at}")
        except SystemExit as err:
            said.append(f"WCS {version} as {name!r}: {_said(str(err))}")
            continue
        if not raw:
            return b"", url
        problem = not_a_raster(raw)
        if not problem:
            return raw, url
        said.append(f"WCS {version}: {problem}")
    raise CutFailed(
        "no version of WCS on that GeoServer returned this tile as a GeoTIFF.\n  "
        + "\n  ".join(said)
        + f"\n  the coverage is {world['coverage']!r} at {world['url']}")


class CutFailed(Exception):
    """The ground could not be cut, and why — an ordinary exception.

    The importer raises SystemExit for a person at a terminal, and SystemExit
    is a BaseException: inside a request handler it walked straight past
    `except Exception`, killed the thread and closed the socket, so curl said
    "Empty reply from server" and the tab saw nothing at all.
    """


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
            raw, url = _ask(world, tile_bounds_3857(z, x, y), auth, f"{z}/{x}/{y}")
            if not raw:
                return None
            try:
                body = encode_geotiff(raw, tile_bounds_3857(z, x, y))
            except Exception as err:  # noqa: BLE001 - said back to the browser
                raise CutFailed(f"the coverage came back but could not be read:"
                                f" {err} — asked: {url}") from err
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
