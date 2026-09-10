"""Asks a GeoServer what it has, so nobody has to type layer names.

WFS and WCS both answer GetCapabilities with XML listing everything published.
Parsed by local tag name rather than by namespace: the namespaces differ between
GeoServer versions and between WFS 1.1/2.0, the tag names do not.

When a server lists nothing, that is reported with what it actually said — the
root element, any exception text, the URL asked. "No layers" on its own is a
dead end, and the server is never the one who can see the mistake.
"""
from __future__ import annotations

import urllib.parse
import xml.etree.ElementTree as ET

from .importer import _auth_header, absolute_url, fetch

# Newest first. GeoServer has answered WFS 1.1.0 for twenty years and some
# installations still have 2.0.0 switched off.
WFS_VERSIONS = ("2.0.0", "1.1.0")
WCS_VERSIONS = ("2.0.1", "1.1.1", "1.0.0")


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
    parsed = urllib.parse.urlparse(absolute_url(base))
    path = parsed.path.rstrip("/")
    for suffix in ("/wfs", "/wcs", "/ows", "/wms"):
        if path.lower().endswith(suffix):
            path = path[: -len(suffix)]
            break
    return parsed._replace(path=f"{path}/{service}", query="", fragment="").geturl()


def capabilities(base: str, service: str, version: str, auth: dict):
    """(parsed, raw, url). Raises with the body when it is not XML at all."""
    query = urllib.parse.urlencode(
        {"service": service, "version": version, "request": "GetCapabilities"})
    url = f"{service_url(base, service.lower())}?{query}"
    raw = fetch(url, auth, what=f"{service} {version}")
    try:
        return ET.fromstring(raw), raw, url
    except ET.ParseError as err:
        raise SystemExit(
            f"import: {url}\n  did not answer with XML ({err}). The first of what "
            f"it did say:\n  {raw[:300].decode('utf8', 'replace')}"
        ) from err


def exception_text(root) -> str | None:
    """OWS and the older ServiceException both say why, in different tags."""
    for tag in ("ExceptionText", "ServiceException", "ExceptionReport"):
        text = first_text(root, tag)
        if text:
            return text
    if local(root.tag) in ("ExceptionReport", "ServiceExceptionReport"):
        return (root.get("exceptionCode") or "the server returned an exception "
                "with no text in it")
    return None


def _nothing_listed(service: str, tried: list[tuple[str, str, bytes]]) -> SystemExit:
    """Everything answered, nothing was in it. Say what came back."""
    lines = [f"import: connected, but no {service} layers were listed."]
    for version, url, raw in tried:
        try:
            root = ET.fromstring(raw)
            root_tag, said = local(root.tag), exception_text(root)
        except ET.ParseError:
            root_tag, said = "?", None
        lines.append(f"  {version}: <{root_tag}> from {url}")
        # The server's own words are the answer when there is one; everything
        # else here is a guess about why it said nothing.
        if said:
            lines.append(f"    it said: {said}")
    head = tried[-1][2][:400].decode("utf8", "replace").replace("\n", " ")
    lines.append(f"  It began: {head}")
    lines.append("  If your layers live in one workspace, try its address "
                 "(…/geoserver/thatworkspace).")
    return SystemExit("\n".join(lines))


def feature_types(base: str, auth: dict) -> list[dict]:
    """Every vector layer, as {name, title, bbox}."""
    tried: list[tuple[str, str, bytes]] = []
    for version in WFS_VERSIONS:
        root, raw, url = capabilities(base, "WFS", version, auth)
        problem = exception_text(root)
        if problem and not find_all(root, "FeatureType"):
            tried.append((version, url, raw))
            continue
        out = []
        for node in find_all(root, "FeatureType"):
            name = first_text(node, "Name")
            if name:
                out.append({"name": name,
                            "title": first_text(node, "Title") or name,
                            "bbox": bbox_of(node)})
        if out:
            return sorted(out, key=lambda f: f["name"])
        tried.append((version, url, raw))
    raise _nothing_listed("WFS", tried)


def bbox_of(node) -> list[float] | None:
    """WGS84BoundingBox (WFS 2.0) or LatLongBoundingBox (WFS 1.1)."""
    lower = first_text(node, "LowerCorner")
    upper = first_text(node, "UpperCorner")
    if lower and upper:
        try:
            west, south = (float(v) for v in lower.split()[:2])
            east, north = (float(v) for v in upper.split()[:2])
            return [west, south, east, north]
        except ValueError:
            return None
    for child in node.iter():
        if local(child.tag) in ("LatLongBoundingBox", "WGS84BoundingBox"):
            try:
                return [float(child.get(k)) for k in ("minx", "miny", "maxx", "maxy")]
            except (TypeError, ValueError):
                return None
    return None


def coverages(base: str, auth: dict) -> list[dict]:
    """Every raster layer, as {id, title}. These are the elevation candidates."""
    tried: list[tuple[str, str, bytes]] = []
    for version in WCS_VERSIONS:
        root, raw, url = capabilities(base, "WCS", version, auth)
        out = []
        # WCS 2.0 says CoverageId; 1.1 says Identifier; 1.0 says name.
        for node in find_all(root, "CoverageSummary") + find_all(root, "CoverageOfferingBrief"):
            ident = (first_text(node, "CoverageId") or first_text(node, "Identifier")
                     or first_text(node, "name"))
            if ident:
                out.append({"id": ident, "title": first_text(node, "Title") or ident})
        if out:
            return sorted(out, key=lambda c: c["id"])
        tried.append((version, url, raw))
    raise _nothing_listed("WCS", tried)


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
