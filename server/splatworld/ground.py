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
from . import crs
from .importer import DEM_SIZE, Unreachable, _auth_header, fetch

# How many more samples the coverage is asked for than the tile keeps. A
# GeoServer scales with nearest neighbour whatever it is asked, and a survey
# decimated that way is stripes; asked for twice as many and read back cubic,
# every kept sample is an average of the survey around it.
OVERSAMPLE = 2

# Two tabs walking onto the same tile at the same moment must not both cut it.
_cutting: dict[tuple[int, int, int], threading.Lock] = {}
_cutting_guard = threading.Lock()


def _lock(key: tuple) -> threading.Lock:
    with _cutting_guard:
        return _cutting.setdefault(key, threading.Lock())


# What each kind of ground is served as: elevation as dem-v2 samples, an
# albedo or a shade as the PNG the WMS drew, which the browser decodes.
EXT = {"dem": "r16", "albedo": "png", "shade": "png"}
IMAGE_SIZE = 512


def tile_path(cfg: Config, z: int, x: int, y: int, kind: str = "dem") -> Path:
    return cfg.files / "geo" / kind / str(z) / str(x) / f"{y}.{EXT[kind]}"


def ground_of(conn) -> dict | None:
    row = conn.execute(
        "SELECT geoserver_url, coverage, st_xmin(extent), st_ymin(extent),"
        " st_xmax(extent), st_ymax(extent) FROM ground").fetchone()
    if not row:
        return None
    return {"url": row[0], "coverage": row[1],
            "extent": (row[2], row[3], row[4], row[5])}


def layers_of(conn, kind: str) -> list[dict]:
    """The ground's sources of one kind, in priority order (db/0106).

    For elevation the `ground` row itself comes first; the layers follow.
    """
    out = []
    if kind == "dem":
        world = ground_of(conn)
        if world:
            out.append(world)
    rows = conn.execute(
        "SELECT geoserver_url, layer, st_xmin(extent), st_ymin(extent),"
        " st_xmax(extent), st_ymax(extent) FROM ground_layer"
        " WHERE kind = %s ORDER BY priority, id", (kind,)).fetchall()
    for row in rows:
        out.append({"url": row[0], "coverage": row[1],
                    "extent": (row[2], row[3], row[4], row[5])})
    return out


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

    `bounds` is the tile in the tile projection. The coverage is asked for in its own CRS
    — a Swiss DEM is LV95, and asking GeoServer to reproject as well is one more
    thing that can be refused — so what comes back is warped here, onto exactly
    the box the tile is.
    """
    import numpy as np
    import rasterio
    from rasterio.io import MemoryFile
    from rasterio.vrt import WarpedVRT

    from . import dem

    # Cubic, not bilinear: what arrives is asked for at twice the tile's
    # samples (OVERSAMPLE), and a bilinear read of every second one would keep
    # the grid GeoServer's nearest-neighbour scaling laid over the survey.
    with MemoryFile(raw) as memfile, memfile.open() as src:
        # Elevation in whole metres, or in 256 steps of the coverage's range,
        # is a staircase whatever is done with it afterwards. A survey at
        # half a metre is float32; say so rather than cut steps.
        if src.dtypes[0] in ("uint8", "int8"):
            raise CutFailed(f"the coverage came back as {src.dtypes[0]}: publish the"
                            " elevation as float32 (or int16 at least), not as an 8-bit image")
        # Whole metres are a staircase too: on a hillside every metre of rise
        # is a shelf and a riser, and the frames drew them as terraces. An
        # int16 survey, or a float one someone rounded, arrives with nearly
        # every sample on a whole number; a survey at half a metre or better
        # does not. Judged on the samples as they came, before the warp puts
        # fractions between them, and without the fill outside the data,
        # which is one whole number over most of a tile that reaches past it.
        if whole_metres(src.read(1), src.nodata):
            raise CutFailed("the coverage came back in whole metres (every sample a round"
                            " number): publish the elevation as float32 at the survey's own"
                            " precision, not rounded")
        if bounds is None or src.crs is None:
            band = src.read(1, out_shape=(DEM_SIZE, DEM_SIZE),
                            resampling=rasterio.enums.Resampling.cubic)
        else:
            west, south, east, north = bounds
            with WarpedVRT(src, crs=crs.TILE,
                           transform=rasterio.transform.from_bounds(
                               west, south, east, north, DEM_SIZE, DEM_SIZE),
                           width=DEM_SIZE, height=DEM_SIZE,
                           resampling=rasterio.enums.Resampling.cubic) as vrt:
                band = vrt.read(1)
        values = band.astype("float64")
        if src.nodata is not None:
            values = np.where(values == src.nodata, np.nan, values)
        return dem.encode(values)


def whole_metres(band, nodata) -> bool:
    """Whether nearly every sample of a survey sits on a whole number."""
    import numpy as np

    values = band.astype("float64")
    finite = values[np.isfinite(values)]
    if nodata is not None:
        finite = finite[finite != nodata]
    if not finite.size:
        return False
    distinct, counts = np.unique(finite, return_counts=True)
    survey = finite[finite != distinct[np.argmax(counts)]]
    if distinct.size <= 50 or not survey.size:
        return False
    return bool(np.mean(np.abs(survey - np.round(survey)) < 1e-6) > 0.99)


def native_bounds(native: str | None, bounds: tuple) -> tuple:
    """The tile's box in the coverage's own CRS."""
    if not native:
        return bounds
    from rasterio.warp import transform_bounds

    target = native if ":" in str(native) else f"EPSG:{native}"
    return tuple(transform_bounds(crs.TILE, target, *bounds))


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

    2.0.1 is asked more than once. Scaling names the grid's axes, which the
    description gives; where it does not, i and j are the usual pair; and a
    coverage that will not be scaled at all is asked for unscaled, because
    encode_geotiff() resamples onto the tile's box regardless. That last one
    costs bandwidth, so it is the last thing tried rather than the first.

    The combination that answered is remembered and tried first next time. A
    GeoServer with 1.0.0 and 1.1.1 switched off refuses those two on every
    tile of every zoom, and a world is thousands of tiles: the order is a
    guess only until the first answer.
    """
    from . import geoserver

    said: list[str] = []
    # Did anything answer at all? A service that refuses this tile is a
    # different thing from one that is not running, and only the second is
    # worth telling a player their world is broken over.
    answered = False
    for version, name in _attempts(world, geoserver.spellings(world["coverage"])):
        box, axes = bounds, None
        scalings: list[tuple | None] = [None]
        if version == "2.0.1":
            # What this coverage calls its axes, and the box in its own CRS.
            try:
                about = geoserver.describe_coverage(world["url"], name, auth)
                answered = True
            except Unreachable as err:
                said.append(f"WCS {version} as {name!r}: {_said(str(err))}")
                continue
            except SystemExit as err:
                answered = True
                said.append(f"WCS {version} as {name!r}: {_said(str(err))}")
                continue
            axes = tuple(about["axes"])
            box = native_bounds(about["crs"], bounds)
            # Where the data actually is, as the coverage itself describes it.
            # The extent recorded when the ground was chosen can be wider — a
            # declared bounding box often is — and a tile outside the data
            # comes back as a 500 with an exception report in it rather than as
            # an empty raster. There is no ground there; that is not a failure,
            # it is the edge of the world (SPEC §3.8), and `cut` answers 404.
            if about.get("envelope") and not crs.clip(box, about["envelope"]):
                return b"", "outside the coverage"
            box = crs.clip(box, about["envelope"]) or box
            world.setdefault("native", {})[version] = box
            scalings = _remembered_scalings(world, about.get("grid_axes"))
        for scale_axes in scalings:
            url = geoserver.coverage_tile_url(
                world["url"], name, box, DEM_SIZE * OVERSAMPLE, version=version,
                axes=axes, scale_axes=scale_axes)
            how = f" scaled on {'/'.join(scale_axes)}" if scale_axes else ""
            try:
                raw = fetch(url, auth, what=f"elevation for {at}")
                answered = True
            except Unreachable as err:
                said.append(f"WCS {version} as {name!r}{how}: {_said(str(err))}")
                continue
            except SystemExit as err:
                answered = True
                said.append(f"WCS {version} as {name!r}{how}: {_said(str(err))}")
                continue
            if not raw:
                return b"", url
            problem = not_a_raster(raw)
            if not problem:
                _worked[_world_key(world)] = (version, name, scale_axes)
                return raw, url
            said.append(f"WCS {version}{how}: {problem}")
    head = ("that GeoServer would not give this tile as a GeoTIFF"
            if answered else "nothing answered at that GeoServer")
    raise CutFailed(
        f"{head}.\n  " + "\n  ".join(said)
        + f"\n  the coverage is {world['coverage']!r} at {world['url']}")


# What answered last time, per coverage: (version, spelling, scale axes).
_worked: dict[tuple[str, str], tuple] = {}


def _world_key(world: dict) -> tuple[str, str]:
    return (world["url"], world["coverage"])


def _attempts(world: dict, names: list[str]) -> list[tuple[str, str]]:
    """Every version and spelling to try, the one that worked last time first."""
    out = [(v, n) for v in ("1.0.0", "2.0.1", "1.1.1") for n in names]
    known = _worked.get(_world_key(world))
    if known:
        first = (known[0], known[1])
        if first in out:
            out.remove(first)
            out.insert(0, first)
    return out


def _scalings(grid: list[str] | None) -> list[tuple | None]:
    """The scale axes to try, in order, ending with not scaling at all.

    GeoServer answered "ScaleAxisUndefined, locator E": `subset` names the
    envelope's axes (E and N on a Swiss coverage) and `scalesize` names the
    grid's (i and j). The description is asked for them; i/j is what every
    GeoServer has called them anyway; and an unscaled coverage still becomes
    this tile, because encode_geotiff() warps it onto the tile's own box.
    """
    out: list[tuple | None] = []
    if grid and len(grid) >= 2:
        out.append((grid[0], grid[1]))
    if ("i", "j") not in out:
        out.append(("i", "j"))
    out.append(None)
    return out


def _remembered_scalings(world: dict, grid: list[str] | None) -> list[tuple | None]:
    """The scalings to try, the one that answered last time first."""
    out = _scalings(grid)
    known = _worked.get(_world_key(world))
    if known and known[2] in out:
        out.remove(known[2])
        out.insert(0, known[2])
    return out


class CutFailed(Exception):
    """The ground could not be cut, and why — an ordinary exception.

    The importer raises SystemExit for a person at a terminal, and SystemExit
    is a BaseException: inside a request handler it walked straight past
    `except Exception`, killed the thread and closed the socket, so curl said
    "Empty reply from server" and the tab saw nothing at all.
    """


def cut(cfg: Config, z: int, x: int, y: int, kind: str = "dem") -> Path | None:
    """This tile of one kind of ground as a file, cutting it first if nobody has.

    Returns None when there is no world here: no ground chosen, or no layer of
    this kind reaches the tile. The viewer says so rather than showing a hole.
    Elevation comes from the first layer that reaches the tile and answers
    (db/0106: the ground, then its dem layers by priority); an albedo or a
    shade from the first WMS layer of that kind that reaches it.
    """
    target = tile_path(cfg, z, x, y, kind)
    with _lock((kind, z, x, y)):
        # A tile cut at any earlier size — dem-v1's uint16, or float32 at the
        # 256 of before — is the stepping or the grid a player sees on every
        # hillside: it is cut again, the once.
        if target.is_file() and not (kind == "dem"
                                     and target.stat().st_size != DEM_SIZE * DEM_SIZE * 4):
            return target
        with psycopg.connect(cfg.dsn(), autocommit=True) as conn:
            auth = _auth_header(cfg.geoserver_user, cfg.geoserver_admin_password)
            body = None
            for layer in layers_of(conn, kind):
                if not covers(layer["extent"], z, x, y):
                    continue
                body = (_cut_dem(layer, z, x, y, auth) if kind == "dem"
                        else _cut_image(layer, z, x, y, auth))
                if body:
                    break
            if not body:
                return None
            target.parent.mkdir(parents=True, exist_ok=True)
            # Written beside and moved into place, so a second tab never reads
            # half a tile.
            tmp = target.with_suffix(f".{os.getpid()}.part")
            tmp.write_bytes(body)
            os.replace(tmp, target)
            if kind == "dem":
                remember(conn, z, x, y, hashlib.sha256(body).hexdigest(), len(body))
            return target


def _cut_dem(world: dict, z: int, x: int, y: int, auth: dict) -> bytes | None:
    from . import dem

    box = crs.tile_bounds(z, x, y)
    # Ask for the part of this tile the coverage actually has. A tile at z10
    # is twenty-seven kilometres across and a coverage is often four, and a
    # WCS asked for ground it has not got answers with an exception report
    # rather than with nodata. What comes back is warped onto the whole tile
    # regardless, so the rest of it is nodata, which is what it is.
    asked = crs.clip(box, crs.merc_box(world["extent"]))
    if asked is None:
        return None
    raw, url = _ask(world, asked, auth, f"{z}/{x}/{y}")
    if not raw:
        return None
    try:
        body = encode_geotiff(raw, box)
    except Exception as err:  # noqa: BLE001 - said back to the browser
        raise CutFailed(f"the coverage came back but could not be read:"
                        f" {err} — asked: {url}") from err
    # A tile can clip a coverage's declared extent and still hold none of its
    # survey: what comes back is then nodata warped over the whole tile, which
    # `encode` writes as a tile flat at NODATA_ELEVATION_M. That is not ground,
    # and saying so here is the difference between "outside the coverage" at the
    # first request and a trainer throwing its own output away a quarter of an
    # hour later (server/splatworld/dem.py all_fill).
    if dem.all_fill(body):
        return None
    return body


def _cut_image(layer: dict, z: int, x: int, y: int, auth: dict) -> bytes | None:
    """One tile of a WMS layer as a PNG, drawn straight in the tile projection."""
    from . import geoserver

    url = geoserver.map_tile_url(layer["url"], layer["coverage"], crs.tile_bounds(z, x, y),
                                 IMAGE_SIZE)
    raw = fetch(url, auth, what=f"{layer['coverage']} for {z}/{x}/{y}")
    if not raw.startswith(b"\x89PNG"):
        raise CutFailed(f"{layer['coverage']} did not come back as a PNG: "
                        f"{_said(raw[:300].decode('utf8', 'replace'))} — asked: {url}")
    return raw


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


def parse_request(path: str) -> tuple[int, int, int, str] | None:
    """/geo/{kind}/{z}/{x}/{y}.{ext} -> (z, x, y, kind), or None otherwise."""
    import re

    m = re.fullmatch(r"/geo/(dem|albedo|shade)/(\d+)/(\d+)/(\d+)\.(r16|png)", path)
    if not m:
        return None
    kind, ext = m.group(1), m.group(5)
    if EXT[kind] != ext:
        return None
    z, x, y = (int(v) for v in m.groups()[1:4])
    if z % 2 or z < 6 or z > 20 or x >= 2 ** z or y >= 2 ** z:
        return None
    return z, x, y, kind


def probe(cfg: Config, z: int, x: int, y: int, out=print) -> int:
    """Every WCS request this tile would make, and the whole answer to each.

    `cut()` reports a failure in one line, and one line is not enough to tell a
    coverage that is not there from one that will not scale: the reason is an
    OGC exception report, and it arrives truncated wherever it is shown. This
    asks the same questions `_ask()` asks and prints what came back, so the
    reason can be read rather than guessed at.
    """
    from . import geoserver

    with psycopg.connect(cfg.dsn(), autocommit=True) as conn:
        world = ground_of(conn)
    if not world:
        out("no ground is chosen yet — pick a coverage in Setup first")
        return 1
    out(f"coverage      {world['coverage']!r}")
    out(f"geoserver     {world['url']}")
    out(f"extent        {world['extent']} (lon/lat)")
    if not covers(world["extent"], z, x, y):
        out(f"\n{z}/{x}/{y} is outside that extent: no world here, and nothing"
            " would be asked for.")
        return 1

    auth = _auth_header(cfg.geoserver_user, cfg.geoserver_admin_password)
    bounds = crs.tile_bounds(z, x, y)
    out(f"\n{z}/{x}/{y} is {bounds} in {crs.TILE}")
    for version in ("1.0.0", "2.0.1", "1.1.1"):
        for name in geoserver.spellings(world["coverage"]):
            out(f"\n--- WCS {version} as {name!r}")
            box, axes = bounds, None
            scalings: list[tuple | None] = [None]
            if version == "2.0.1":
                try:
                    about = geoserver.describe_coverage(world["url"], name, auth)
                except SystemExit as err:
                    out(f"  DescribeCoverage failed: {err}")
                    continue
                axes = tuple(about["axes"])
                box = native_bounds(about["crs"], bounds)
                out(f"  DescribeCoverage: axes {axes}, CRS {about['crs']},"
                    f" grid axes {about.get('grid_axes')}")
                out(f"  the box in that CRS: {box}")
                scalings = _scalings(about.get("grid_axes"))
            for scale_axes in scalings:
                url = geoserver.coverage_tile_url(
                    world["url"], name, box, DEM_SIZE, version=version,
                    axes=axes, scale_axes=scale_axes)
                out(f"  scalesize on {'/'.join(scale_axes) if scale_axes else 'nothing'}")
                out(f"  GET {url}")
                try:
                    raw = fetch(url, auth, what="the coverage")
                except SystemExit as err:
                    out(f"  it refused: {err}")
                    continue
                problem = not_a_raster(raw)
                if problem:
                    out(f"  it answered, but not with a raster: {problem}")
                else:
                    out(f"  a GeoTIFF, {len(raw)} bytes — this one works")
                    break
    return 0
