"""Imports a region: your elevation and your map layers.

    splatworld import my-region.json

Elevation comes from a GeoTIFF — a file on disk, or a URL, which is how a
GeoServer coverage gets here (paste its WCS GetCoverage link). Layers come from
a GeoServer over WFS, which hands back GeoJSON over plain HTTP, or from a
.geojson file.

Nothing here computes anything about the world (Invariant 9): it cuts inputs
into the immutable file store, writes `area` and `feature` rows, and marks the
covering tiles dirty. Browser tabs still do the compiling.
"""
from __future__ import annotations

import base64
import json
import math
import re
import urllib.parse
import urllib.request
from pathlib import Path

import psycopg
from psycopg import sql

from . import crs
from .config import Config

KINDS = ("road", "forest", "water", "footprint", "terrainmod")
AREA_ZOOM = 12
MIN_ZOOM = 6

# dem-v1: uint16, 256x256, row-major, north-west first, in the tile projection,
# elevation_m = value * 0.2 - 500. The same encoding tools/seed-dem.sh writes
# with gdal_translate -scale -500 12607 0 65535, and the one client/lib/geo.js
# reads back (DEM_SCALE, DEM_OFFSET).
DEM_ALGO = "dem-v1"
DEM_SIZE = 256
DEM_SCALE = 0.2
DEM_OFFSET = -500.0
DEM_MIN, DEM_MAX = -500.0, 12607.0

class ImportError_(SystemExit):
    """A problem with the config or the sources, phrased for a person."""


def die(message: str) -> None:
    raise ImportError_(f"import: {message}")


# ------------------------------------------------------------------ sources

def _auth_header(user: str | None, password: str | None) -> dict[str, str]:
    if not user:
        return {}
    token = base64.b64encode(f"{user}:{password or ''}".encode()).decode()
    return {"Authorization": f"Basic {token}"}


def absolute_url(url: str) -> str:
    """Whatever someone typed, made into something urllib will open.

    "gis.example.com/geoserver" has no scheme and urllib refuses it outright;
    worse, "localhost:8080/geoserver" parses with scheme "localhost", so the
    port becomes part of a URL type that does not exist. Both are what a person
    types, so both mean http.
    """
    url = url.strip()
    if not re.match(r"^[a-zA-Z][a-zA-Z0-9+.\-]*://", url):
        url = f"http://{url}"
    return url


def fetch(url: str, headers: dict[str, str], *, what: str) -> bytes:
    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=300) as res:
            return res.read()
    except urllib.error.HTTPError as err:
        body = err.read()[:400].decode("utf8", "replace")
        die(f"{what}: {err.code} {err.reason} from {url}\n  {body}")
    except OSError as err:
        die(f"{what}: could not reach {url} — {err}")
    except ValueError as err:
        die(f"{what}: {url} is not an address I can open — {err}")
    return b""


def wfs_url(base: str, type_name: str, count: int | None) -> str:
    # Whatever was typed — the root, a workspace, or a full WFS url — asked as
    # the WFS endpoint. Without this, GetFeature against …/geoserver answers
    # with the admin page's HTML and the import says "that was not GeoJSON".
    from .geoserver import service_url  # imported here: geoserver imports this

    u = urllib.parse.urlparse(service_url(base, "wfs"))
    query = {
        "service": "WFS", "version": "2.0.0", "request": "GetFeature",
        "typeNames": type_name, "outputFormat": "application/json",
        "srsName": crs.WORLD,
    }
    if count:
        query["count"] = str(count)
    return u._replace(query=urllib.parse.urlencode(query)).geturl()


def load_layer(spec: dict, defaults: dict, base_dir: Path, cfg=None) -> dict:
    if spec.get("table"):
        # A layer that is already a table here: read it, do not copy it.
        from . import postgis

        if cfg is None:
            die(f"{spec['name']}: a table layer needs the server's database")
        return postgis.as_geojson(cfg, spec)

    if spec.get("file"):
        path = Path(spec["file"])
        path = path if path.is_absolute() else base_dir / path
        if not path.is_file():
            die(f"{spec['name']}: no such file {path}")
        return json.loads(path.read_text(encoding="utf8"))

    base = spec.get("wfs") or defaults.get("wfs")
    if not base:
        die(f"{spec['name']}: give it a \"file\", or a \"wfs\" url "
            f"(or a top-level \"geoserver\": {{\"wfs\": ...}})")
    type_name = spec.get("typeName") or die(f"{spec['name']}: no \"typeName\"")
    headers = _auth_header(spec.get("user") or defaults.get("user"),
                           spec.get("password") or defaults.get("password"))
    raw = fetch(wfs_url(base, type_name, spec.get("count")), headers,
                what=spec["name"])
    try:
        return json.loads(raw)
    except ValueError:
        # GeoServer answers a bad request with an XML ServiceException.
        die(f"{spec['name']}: that was not GeoJSON —\n  "
            f"{raw[:300].decode('utf8', 'replace')}")
    return {}


# ------------------------------------------------------------ normalisation

def as_number(value) -> float | None:
    if value is None:
        return None
    text = str(value).replace(",", ".")
    kept = "".join(c for c in text if c.isdigit() or c in ".eE+-")
    try:
        number = float(kept)
    except ValueError:
        return None
    return number if math.isfinite(number) else None


# What the compiler reads as words rather than numbers (client/lib/props.js).
TEXT_PROPS = ("species", "leaf_type", "roof", "name", "model")


def props_of(spec: dict, attrs: dict | None) -> dict:
    """`{"height": "bldg_hoehe"}` — your column, the world's property."""
    out: dict = {}
    for want, source in (spec.get("props") or {}).items():
        raw = (attrs or {}).get(source)
        if want in TEXT_PROPS:
            if raw is not None and str(raw).strip():
                out[want] = str(raw).strip()
            continue
        value = as_number(raw)
        if value is not None:
            out[want] = value
    for key in spec.get("keep") or []:
        if (attrs or {}).get(key) is not None:
            out[key] = attrs[key]
    return out


def rows_of(spec: dict, geojson: dict, index: int) -> list[dict]:
    feats = geojson.get("features") or ([geojson] if geojson.get("type") == "Feature" else [])
    rows = []
    for i, feature in enumerate(feats):
        if not feature or not feature.get("geometry"):
            continue
        ident = feature.get("id") or (feature.get("properties") or {}).get(
            spec.get("idField", "")) or f"{index}-{i}"
        rows.append({
            "src": f"{spec['name']}:{ident}",
            "kind": spec["kind"],
            "props": props_of(spec, feature.get("properties")),
            "geom": feature["geometry"],
        })
    return rows


def bbox_of(rows: list[dict]) -> list[float]:
    box = [math.inf, math.inf, -math.inf, -math.inf]

    def walk(coords) -> None:
        if coords and isinstance(coords[0], (int, float)):
            box[0] = min(box[0], coords[0]); box[1] = min(box[1], coords[1])
            box[2] = max(box[2], coords[0]); box[3] = max(box[3], coords[1])
        else:
            for part in coords or []:
                walk(part)

    for row in rows:
        walk(row["geom"].get("coordinates"))
    return box


# ------------------------------------------------------------------ database

def region_tiles(conn, bbox: list[float], max_zoom: int) -> list[tuple[int, int, int]]:
    """The world's own tile maths, not a second copy of it here.

    tiles_for_geom is what the dirty trigger uses, so a seeded tile and a
    dirtied one are the same tile.
    """
    rows = conn.execute(
        "SELECT t.z, t.x, t.y FROM tiles_for_geom("
        "  st_makeenvelope(%s, %s, %s, %s, world_srid()), %s, %s) AS t"
        " ORDER BY t.z, t.x, t.y",
        (*bbox, MIN_ZOOM, max_zoom),
    ).fetchall()
    return [(int(z), int(x), int(y)) for z, x, y in rows]


def ensure_owner(conn, email: str, password: str):
    row = conn.execute("SELECT id FROM auth.user WHERE email = %s", (email,)).fetchone()
    if row:
        uid = row[0]
    else:
        uid = conn.execute("SELECT register(%s, %s)", (email, password)).fetchone()[0]
    conn.execute("UPDATE auth.user SET role = 'admin' WHERE id = %s", (uid,))
    return uid


def seed_areas(conn, uid, bbox: list[float], detail: int) -> int:
    """One area per z12 tile the region touches — the unit of ownership."""
    return conn.execute(
        "INSERT INTO area (geom, owner_id, detail, rules)"
        " SELECT tile_bbox(%s, t.x, t.y), %s, %s,"
        "        jsonb_build_object('src', 'import', 'z12', t.x || '/' || t.y)"
        " FROM tiles_for_geom(st_makeenvelope(%s, %s, %s, %s, world_srid()), %s, %s) AS t"
        " WHERE NOT EXISTS (SELECT 1 FROM area a WHERE a.owner_id = %s"
        "                   AND a.rules ->> 'z12' = t.x || '/' || t.y)",
        (AREA_ZOOM, uid, detail, *bbox, AREA_ZOOM, AREA_ZOOM, uid),
    ).rowcount


def mark_dirty(conn, bbox: list[float], detail: int) -> int:
    """The rows the trigger would have written.

    A trigger marks tiles dirty when somebody edits the world; ground nobody has
    edited has no edit to fire one, so the import writes them the same way, from
    the same tiles_for_geom. A tile the world already knows is left alone.
    """
    return conn.execute(
        "INSERT INTO tile (z, x, y, dirty, expected_version)"
        " SELECT t.z, t.x, t.y, true, 1"
        " FROM tiles_for_geom(st_makeenvelope(%s, %s, %s, %s, world_srid()), %s, %s) AS t"
        " ON CONFLICT (z, x, y) DO NOTHING",
        (*bbox, MIN_ZOOM, detail),
    ).rowcount


def register_artifacts(conn, uid, entries: list[tuple[str, int]], kind: str, algo: str) -> None:
    """register_artifact under the owner's identity — the RPC a worker calls."""
    if not entries:
        return
    # The casts are not decoration: inside json_build_object the server cannot
    # infer a parameter's type and refuses the statement.
    conn.execute(
        "SELECT set_config('request.jwt.claims',"
        " json_build_object('sub', %s::text, 'role', 'admin')::text, true)",
        (str(uid),))
    for sha, size in entries:
        conn.execute("SELECT register_artifact(%s, %s, %s, %s)", (sha, kind, size, algo))


def insert_features(conn, uid, rows: list[dict]) -> int:
    """Flat, valid, and inside an area you own.

    Z = 0: the world keeps plan geometry and takes ground height from the DEM at
    compile time, exactly as tools/seed-osm.sh does. props.src makes a second
    import of the same layer a no-op.
    """
    if not rows:
        return 0
    conn.execute("CREATE TEMP TABLE import_raw (doc jsonb) ON COMMIT DROP")
    with conn.cursor().copy("COPY import_raw (doc) FROM STDIN") as copy:
        for row in rows:
            copy.write_row([json.dumps(row)])
    geom = ("st_makevalid(st_setsrid(st_geomfromgeojson(r.doc -> 'geom'), world_srid()))")
    return conn.execute(
        f"INSERT INTO feature (area_id, kind, geom, props)"
        f" SELECT a.id, r.doc ->> 'kind', st_force3d({geom}),"
        f"        (r.doc -> 'props') || jsonb_build_object('src', r.doc ->> 'src')"
        f" FROM import_raw r"
        f" JOIN area a ON a.owner_id = %s"
        f"   AND st_intersects(a.geom, st_pointonsurface({geom}))"
        f" WHERE st_isvalid({geom})"
        f"   AND NOT EXISTS (SELECT 1 FROM feature f"
        f"                   WHERE f.props ->> 'src' = r.doc ->> 'src')",
        (uid,),
    ).rowcount


# --------------------------------------------------------------------- run

def elevation_source(spec: dict, defaults: dict, base_dir: Path, work: Path) -> Path | None:
    """A GeoTIFF on disk, or one fetched from a URL (a WCS GetCoverage link)."""
    if not spec:
        return None
    if spec.get("file"):
        path = Path(spec["file"])
        path = path if path.is_absolute() else base_dir / path
        if not path.is_file():
            die(f"elevation: no such file {path}")
        return path
    url = spec.get("url")
    if not url and spec.get("coverage"):
        # The import page offers the coverages a GeoServer publishes by name;
        # the GetCoverage request is built here rather than pasted by hand.
        from . import geoserver

        base = spec.get("wfs") or defaults.get("wfs")
        if not base:
            die('elevation by "coverage" needs the GeoServer address')
        url = geoserver.coverage_url(base, spec["coverage"])
    if not url:
        die('elevation needs a "file", a "url", or a "coverage"')
    headers = _auth_header(spec.get("user") or defaults.get("user"),
                           spec.get("password") or defaults.get("password"))
    print(f"  fetching elevation from {url}")
    payload = fetch(url, headers, what="elevation")
    if payload[:4] not in (b"II*\x00", b"MM\x00*", b"II+\x00", b"MM\x00+"):
        die("elevation: that URL did not return a GeoTIFF —\n  "
            f"{payload[:200].decode('utf8', 'replace')}")
    target = work / "elevation.tif"
    target.write_bytes(payload)
    return target


def run(cfg: Config, spec_path: Path) -> int:
    """The command-line entry: a spec read from a file beside its data."""
    spec = json.loads(spec_path.read_text(encoding="utf8"))
    return run_spec(cfg, spec, spec_path.resolve().parent)


def run_spec(cfg: Config, spec: dict, base_dir: Path, out=print) -> int:
    """The import itself.

    `out` collects the running commentary, so the same code serves the command
    line and the import page, which shows it back to the browser.
    """
    from tempfile import TemporaryDirectory

    print_ = out
    defaults = spec.get("geoserver") or {}
    detail = int(spec.get("detail", 14))
    owner = (spec.get("owner") or {}).get("email", "me@splatworld.local")
    password = (spec.get("owner") or {}).get("password", "change-me")

    rows: list[dict] = []
    for index, layer in enumerate(spec.get("layers") or []):
        layer["name"] = layer.get("name") or layer.get("typeName") or f"layer{index}"
        if layer.get("kind") not in KINDS:
            die(f"{layer['name']}: \"kind\" must be one of {', '.join(KINDS)}")
        got = rows_of(layer, load_layer(layer, defaults, base_dir, cfg), index)
        print_(f"  {layer['name']}: {len(got)} {layer['kind']}")
        rows.extend(got)

    bbox = spec.get("bbox") or (bbox_of(rows) if rows else None)
    if not bbox or not all(map(math.isfinite, bbox)):
        die('could not work out the region — give "bbox": [west, south, east, north]')
    print_(f"  region {', '.join(f'{v:.4f}' for v in bbox)}, detail z{detail}")

    with TemporaryDirectory() as tmp, psycopg.connect(cfg.dsn()) as conn:
        elevation = dict(spec.get("elevation") or {})
        if elevation:
            elevation.setdefault("bbox", bbox)
            elevation.setdefault("detail", detail)
            elevation.setdefault("on_step", print_)
        source = elevation_source(elevation, defaults, base_dir, Path(tmp))
        uid = ensure_owner(conn, owner, password)
        print_(f"  {seed_areas(conn, uid, bbox, detail)} new area(s)")
        print_(f"  {mark_dirty(conn, bbox, detail)} new tile(s) to compile")
        print_(f"  {insert_features(conn, uid, rows)} new feature(s)")

        if source:
            from . import dem  # imported late: rasterio is only needed for this

            tiles = region_tiles(conn, bbox, detail)
            print_(f"  cutting {len(tiles)} elevation tile(s)")
            written, blank = dem.cut(source, cfg.files, tiles)
            register_artifacts(conn, uid, written, "dem", DEM_ALGO)
            print_(f"  {len(written)} elevation tile(s) in the store")
            if blank:
                print_(f"  warning: {len(blank)} tile(s) are outside your "
                      "elevation data and will be flat at sea level")
        else:
            print_("  no elevation given — tiles cannot compile without it")
        conn.commit()

    print_(f"\nDone. Sign in at /app/play.html as {owner} and turn on background work.")
    return 0


# ------------------------------------------------- elevation for what exists

def area_bboxes(conn) -> list[list[float]]:
    """One region per area drawn — nobody types it.

    Per area, not one box over all of them: two areas far apart make a box
    that covers everything between, and one polygon drawn in the wrong place
    once turned "a valley" into "Africa to the Alps" and an hour of download.
    """
    rows = conn.execute(
        "SELECT st_xmin(geom), st_ymin(geom), st_xmax(geom), st_ymax(geom)"
        " FROM area ORDER BY created_at").fetchall()
    return [[float(v) for v in row] for row in rows]


def ensure_account(cfg: Config, email: str, password: str) -> str:
    """The account you sign in as, and the owner QGIS draws as."""
    with psycopg.connect(cfg.dsn()) as conn:
        uid = ensure_owner(conn, email, password)
        conn.commit()
        return str(uid)
