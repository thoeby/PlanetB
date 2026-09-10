"""Buildings, roads, woods and water from OpenStreetMap, for anywhere.

Overpass answers a bounding box with JSON over plain HTTP, so a world can be
made of somewhere real without owning any data, running a GIS, or drawing
anything. Free, no account, no key.

Be a good guest: Overpass is donated infrastructure. One request per import,
a real User-Agent, and a bounded area.
"""
from __future__ import annotations

import json
import urllib.parse
import urllib.request

ENDPOINT = "https://overpass-api.de/api/interpreter"
USER_AGENT = "splatworld/0.1 (world builder; one request per import)"

# A metre of road width per lane, and the widths of the kinds that do not say.
LANE_M = 3.5
ROAD_WIDTH = {
    "motorway": 14.0, "trunk": 12.0, "primary": 10.0, "secondary": 8.0,
    "tertiary": 7.0, "residential": 6.0, "unclassified": 5.0, "service": 4.0,
    "living_street": 5.0, "pedestrian": 4.0, "footway": 2.0, "path": 1.5,
    "track": 3.0, "cycleway": 2.5, "steps": 1.5,
}
# Storeys to metres where a building gives levels but no height.
LEVEL_M = 3.0

QUERY = """[out:json][timeout:{timeout}];
(
  way["building"]({s},{w},{n},{e});
  way["highway"]({s},{w},{n},{e});
  way["landuse"~"^(forest|meadow)$"]({s},{w},{n},{e});
  way["natural"~"^(wood|water|scrub)$"]({s},{w},{n},{e});
  way["waterway"="riverbank"]({s},{w},{n},{e});
  way["landuse"="reservoir"]({s},{w},{n},{e});
);
out geom;"""


def number(value) -> float | None:
    """OSM values are free text: "12", "12 m", "12,5", "3;4" all appear."""
    if value is None:
        return None
    text = str(value).split(";")[0].replace(",", ".")
    kept = "".join(c for c in text if c.isdigit() or c in ".-")
    try:
        found = float(kept)
    except ValueError:
        return None
    return found if found > 0 else None


def classify(tags: dict) -> tuple[str, dict] | None:
    """One OSM element to one of the five kinds the world understands."""
    if tags.get("building"):
        height = number(tags.get("height"))
        if height is None:
            levels = number(tags.get("building:levels"))
            height = levels * LEVEL_M if levels else None
        return "footprint", ({"height": height} if height else {})

    highway = tags.get("highway")
    if highway:
        width = number(tags.get("width"))
        if width is None:
            lanes = number(tags.get("lanes"))
            width = lanes * LANE_M if lanes else ROAD_WIDTH.get(highway)
        return "road", ({"width": width} if width else {})

    if tags.get("landuse") in ("forest", "meadow") or tags.get("natural") in ("wood", "scrub"):
        return "forest", {}
    if (tags.get("natural") == "water" or tags.get("waterway") == "riverbank"
            or tags.get("landuse") == "reservoir"):
        return "water", {}
    return None


def geometry_of(element: dict, kind: str) -> dict | None:
    """Overpass `out geom` gives every node's lat/lon inline."""
    points = [[p["lon"], p["lat"]] for p in element.get("geometry") or []
              if p.get("lat") is not None]
    if len(points) < 2:
        return None
    closed = len(points) >= 4 and points[0] == points[-1]
    if kind == "road":
        return {"type": "LineString", "coordinates": points}
    if not closed:
        # An area tag on an unclosed way is a mapping error, not our business.
        return None
    return {"type": "Polygon", "coordinates": [points]}


def query_for(bbox: list[float], timeout: int) -> str:
    west, south, east, north = bbox
    return QUERY.format(s=south, w=west, n=north, e=east, timeout=timeout)


def fetch(bbox: list[float], *, timeout: int = 120, endpoint: str = ENDPOINT) -> dict:
    body = urllib.parse.urlencode({"data": query_for(bbox, timeout)}).encode()
    request = urllib.request.Request(
        endpoint, data=body, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(request, timeout=timeout + 30) as res:
            return json.loads(res.read())
    except urllib.error.HTTPError as err:
        detail = err.read()[:300].decode("utf8", "replace")
        raise SystemExit(
            f"import: OpenStreetMap refused the request ({err.code} {err.reason}).\n"
            f"  {detail}\n"
            "  Overpass is a free shared service and rate-limits; waiting a minute\n"
            "  usually clears it. A smaller area also helps."
        ) from err
    except OSError as err:
        raise SystemExit(
            f"import: could not reach OpenStreetMap ({err}).\n"
            f"  {endpoint} has to be reachable from this machine."
        ) from err
    except ValueError as err:
        raise SystemExit(f"import: OpenStreetMap sent something that is not JSON ({err})")


def rows(bbox: list[float], **kwargs) -> list[dict]:
    """Features ready for the importer, tagged so a re-import is a no-op."""
    payload = fetch(bbox, **kwargs)
    out = []
    for element in payload.get("elements") or []:
        found = classify(element.get("tags") or {})
        if not found:
            continue
        kind, props = found
        geometry = geometry_of(element, kind)
        if not geometry:
            continue
        out.append({
            "src": f"osm:{element.get('type', 'way')}{element.get('id')}",
            "kind": kind,
            "props": props,
            "geom": geometry,
        })
    return out
