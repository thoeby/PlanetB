"""Asks a GeoServer what it has, so nobody has to type layer names.

WFS and WCS both answer GetCapabilities with XML listing everything published.
Parsed by local tag name rather than by namespace: the namespaces differ between
GeoServer versions and between WFS 1.1/2.0, the tag names do not.
"""
from __future__ import annotations

import urllib.parse
import xml.etree.ElementTree as ET

from .importer import _auth_header, fetch


def local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def find_all(node, name: str):
    return [n for n in node.iter() if local(n.tag) == name]


def first_text(node, name: str) -> str | None:
    for child in node.iter():
        if local(child.tag) == name and (child.text or "").strip():
            return child.text.strip()
    return None


def service_url(base: str, service: str) -> str:
    """A GeoServer endpoint for one service, from whatever the user pasted.

    They may paste the root (…/geoserver), a workspace (…/geoserver/ws) or a
    full service URL (…/geoserver/ws/wfs?…). All three should work.
    """
    parsed = urllib.parse.urlparse(base.strip())
    path = parsed.path.rstrip("/")
    for suffix in ("/wfs", "/wcs", "/ows", "/wms"):
        if path.lower().endswith(suffix):
            path = path[: -len(suffix)]
            break
    return parsed._replace(path=f"{path}/{service}", query="", fragment="").geturl()


def capabilities(base: str, service: str, version: str, auth: dict) -> ET.Element:
    query = urllib.parse.urlencode(
        {"service": service, "version": version, "request": "GetCapabilities"})
    url = f"{service_url(base, service.lower())}?{query}"
    raw = fetch(url, auth, what=f"{service} capabilities")
    try:
        return ET.fromstring(raw)
    except ET.ParseError as err:
        raise SystemExit(
            f"import: {url}\n  did not answer with XML ({err}). Is that a "
            "GeoServer address?"
        ) from err


def bbox_of(node) -> list[float] | None:
    lower = first_text(node, "LowerCorner")
    upper = first_text(node, "UpperCorner")
    if not lower or not upper:
        return None
    try:
        west, south = (float(v) for v in lower.split()[:2])
        east, north = (float(v) for v in upper.split()[:2])
    except ValueError:
        return None
    return [west, south, east, north]


def feature_types(base: str, auth: dict) -> list[dict]:
    """Every vector layer, as {name, title, bbox}."""
    root = capabilities(base, "WFS", "2.0.0", auth)
    out = []
    for node in find_all(root, "FeatureType"):
        name = first_text(node, "Name")
        if not name:
            continue
        out.append({
            "name": name,
            "title": first_text(node, "Title") or name,
            "bbox": bbox_of(node),
        })
    return sorted(out, key=lambda f: f["name"])


def coverages(base: str, auth: dict) -> list[dict]:
    """Every raster layer, as {id, title}. These are the elevation candidates."""
    root = capabilities(base, "WCS", "2.0.1", auth)
    out = []
    for node in find_all(root, "CoverageSummary"):
        ident = first_text(node, "CoverageId")
        if not ident:
            continue
        out.append({"id": ident, "title": first_text(node, "Title") or ident})
    return sorted(out, key=lambda c: c["id"])


def coverage_url(base: str, coverage_id: str) -> str:
    """A GetCoverage request for the whole coverage, as a GeoTIFF."""
    query = urllib.parse.urlencode({
        "service": "WCS", "version": "2.0.1", "request": "GetCoverage",
        "coverageId": coverage_id, "format": "image/tiff",
    })
    return f"{service_url(base, 'wcs')}?{query}"


def probe(base: str, user: str | None, password: str | None) -> dict:
    """What this GeoServer has, for the import page to offer as choices."""
    auth = _auth_header(user, password)
    result: dict = {"wfs": service_url(base, "wfs"), "layers": [], "coverages": []}
    result["layers"] = feature_types(base, auth)
    try:
        result["coverages"] = coverages(base, auth)
    except SystemExit as err:
        # A GeoServer with no raster published, or WCS switched off, is a normal
        # thing to meet; elevation can still come from a file.
        result["coverages_error"] = str(err)
    return result
