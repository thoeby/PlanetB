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
    lines = [f"connected, but no {service} layers were listed."]
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


def _pair(lower: str, upper: str) -> list[float] | None:
    try:
        west, south = (float(v) for v in lower.split()[:2])
        east, north = (float(v) for v in upper.split()[:2])
    except (ValueError, AttributeError):
        return None
    return [west, south, east, north]


def _lonlat(box: list[float] | None) -> list[float] | None:
    """The box, if it is longitude and latitude at all.

    A coverage in LV95 or any other projected CRS publishes its native envelope
    in metres. Read as lon/lat that is not a small error, it is a world nothing
    is ever inside — which is exactly what happened: every tile of a Swiss DEM
    answered "outside the world's coverage" because the extent stored was
    2633000 1124000.
    """
    if not box:
        return None
    west, south, east, north = box
    if abs(west) > 180 or abs(east) > 180 or abs(south) > 90 or abs(north) > 90:
        return None
    return box


def bbox_of(node) -> list[float] | None:
    """The coverage's extent in lon/lat, from whichever element carries it.

    In WCS 2.0 a CoverageSummary carries both its native <ows:BoundingBox> and
    an <ows:WGS84BoundingBox>, in that order, and both hold LowerCorner and
    UpperCorner. So the WGS84 one is looked for by name first; a bare corner
    pair is only trusted when it reads as lon/lat.
    """
    for child in node.iter():
        tag = local(child.tag)
        if tag in ("WGS84BoundingBox", "lonLatEnvelope"):
            corners = [c.text for c in child
                       if local(c.tag) in ("LowerCorner", "UpperCorner", "pos") and c.text]
            if len(corners) >= 2:
                found = _lonlat(_pair(corners[0], corners[1]))
                if found:
                    return found
        if tag == "LatLongBoundingBox":
            try:
                found = _lonlat([float(child.get(k))
                                 for k in ("minx", "miny", "maxx", "maxy")])
            except (TypeError, ValueError):
                found = None
            if found:
                return found

    # Nothing said WGS84. A corner pair that reads as lon/lat is one anyway;
    # one that does not is a projected envelope, and this does not guess.
    return _lonlat(_pair(first_text(node, "LowerCorner"), first_text(node, "UpperCorner")))


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
                # The extent is what makes a coverage choosable: it is where the
                # world will be, and the viewer needs it to say where the edge
                # is (TASKS-usable T0, T1).
                # WCS 2.0 and 1.1 say Title; 1.0 says label.
                out.append({"id": ident,
                            "title": (first_text(node, "Title")
                                      or first_text(node, "label") or ident),
                            "bbox": bbox_of(node)})
        if out:
            return sorted(out, key=lambda c: c["id"])
        tried.append((version, url, raw))
    raise _nothing_listed("WCS", tried)


def describe_coverage(base: str, coverage_id: str, auth: dict) -> dict:
    """A coverage's own CRS, the names it gives its two axes, and its grid's.

    WCS 2.0 subsetting and scaling name axes, and every coverage names them
    differently — E/N, X/Y, Long/Lat, i/j. Guessing produced
    "ScaleAxisUndefined"; DescribeCoverage says, in gml:Envelope's axisLabels.

    They are not the same two names. `subset` names the axes of the envelope's
    CRS (E and N on a Swiss coverage); `scalesize` names the axes of the grid,
    which are i and j, and asking it to scale E gave ScaleAxisUndefined with E
    as the locator. So both are read: gml:Envelope's attribute for the one, the
    domain set's gml:axisLabels for the other.
    """
    query = urllib.parse.urlencode({
        "service": "WCS", "version": "2.0.1", "request": "DescribeCoverage",
        "coverageId": coverage_id,
    }, quote_via=urllib.parse.quote)
    url = f"{service_url(base, 'wcs')}?{query}"
    raw = fetch(url, auth, what=f"description of {coverage_id}")
    try:
        root = ET.fromstring(raw)
    except ET.ParseError as err:
        raise SystemExit(f"{url}\n  did not answer with XML ({err})") from err
    said = exception_text(root)
    grid = grid_axes(root)
    for node in root.iter():
        if local(node.tag) != "Envelope":
            continue
        labels = (node.get("axisLabels") or "").split()
        srs = node.get("srsName") or ""
        if len(labels) >= 2:
            return {"axes": labels[:2], "crs": srs.rsplit("/", 1)[-1] or None,
                    "grid_axes": grid, "url": url}
    raise SystemExit(
        f"that coverage did not describe its axes.\n  asked: {url}"
        + (f"\n  it said: {said}" if said else ""))


def grid_axes(root) -> list[str] | None:
    """What the coverage calls the two axes of its grid, for `scalesize`.

    In a WCS 2.0 description the domain set is a gml:RectifiedGrid, and its
    gml:axisLabels is a child element rather than an attribute. Unreadable or
    absent is not fatal: the caller falls back to i and j, and then to asking
    for the coverage unscaled.
    """
    for node in root.iter():
        if local(node.tag) not in ("RectifiedGrid", "Grid"):
            continue
        for child in node:
            if local(child.tag) == "axisLabels" and (child.text or "").split():
                return (child.text or "").split()[:2]
        labels = (node.get("axisLabels") or "").split()
        if len(labels) >= 2:
            return labels[:2]
    return None


def spellings(coverage_id: str) -> list[str]:
    """The names one coverage might answer to, most likely first.

    A layer named "dem visp demo" is published as `splatworld__dem visp demo`,
    and GeoServer's own conventions for spaces are not the same in every
    service: some paths want them as they are, some as underscores. Rather than
    decide which, ask in order and take whichever answers.
    """
    out = [coverage_id]
    for swap in (coverage_id.replace(" ", "_"), coverage_id.replace(" ", "")):
        if swap not in out:
            out.append(swap)
    return out


def _same_name(a: str, b: str) -> bool:
    """Whether two spellings name the same layer.

    GeoServer writes the workspace separator as "__" in WCS 2.0 and ":"
    everywhere else, and a layer published from a file called "dem visp demo"
    may be catalogued as "dem_visp_demo". None of that changes which layer is
    meant.
    """
    def flat(name: str) -> str:
        tail = name.replace("__", ":").rsplit(":", 1)[-1]
        return tail.replace(" ", "_").replace("-", "_").casefold()

    return flat(a) == flat(b)


def resolve_coverage(base: str, coverage_id: str, auth: dict) -> str | None:
    """The id this GeoServer really publishes for the coverage that was chosen.

    A name is stored when the ground is picked and used verbatim afterwards —
    by WMS, which has no spelling variants to fall back on and answers "layer
    not found" for a name off by one underscore. So it is asked rather than
    assumed: exact match first, then the same layer under another spelling.
    None when this GeoServer publishes nothing like it, which is a different
    problem and is not papered over here.
    """
    try:
        published = [c["id"] for c in coverages(base, auth)]
    except SystemExit:
        return None
    for name in published:
        if name == coverage_id:
            return name
    for name in published:
        if _same_name(name, coverage_id):
            return name
    return None


def wcs10_name(coverage_id: str) -> str:
    """A WCS 2.0 CoverageId as WCS 1.0 spells the same layer.

    A CoverageId may not hold a colon, so GeoServer writes the workspace
    separator as a double underscore: `splatworld__dem visp demo` in 2.0 is
    `splatworld:dem visp demo` in 1.0. Asked with the 2.0 spelling, 1.0 does
    not recognise the layer.
    """
    return coverage_id.replace("__", ":", 1)


def coverage_tile_url(base: str, coverage_id: str, bbox: tuple, size: int,
                      crs: str = "EPSG:3857", version: str = "1.0.0",
                      axes: tuple | None = None,
                      scale_axes: tuple | None = None) -> str:
    """One tile of a coverage: exactly this box, exactly this many samples.

    WCS 1.0.0 rather than 2.0.1 by default, on purpose. 2.0 subsetting names its
    axes after whatever the coverage calls them — X/Y, E/N, Long/Lat, i/j — so a
    request that works against one raster fails against the next. 1.0.0 takes a
    plain BBOX with WIDTH and HEIGHT, which is the whole question being asked
    here. An installation with 1.0.0 switched off is why the version is an
    argument: ground.py tries the others when this one is not understood.
    """
    west, south, east, north = bbox
    if version.startswith("1.0"):
        query = urllib.parse.urlencode({
            "service": "WCS", "version": version, "request": "GetCoverage",
            "coverage": wcs10_name(coverage_id), "CRS": crs, "RESPONSE_CRS": crs,
            "BBOX": f"{west},{south},{east},{north}",
            "WIDTH": size, "HEIGHT": size, "FORMAT": "GeoTIFF",
        }, quote_via=urllib.parse.quote)
    elif version.startswith("1.1"):
        query = urllib.parse.urlencode({
            "service": "WCS", "version": version, "request": "GetCoverage",
            "identifier": wcs10_name(coverage_id), "format": "image/tiff",
            "BoundingBox": f"{west},{south},{east},{north},urn:ogc:def:crs:{crs}",
            "GridBaseCRS": f"urn:ogc:def:crs:{crs}",
        }, quote_via=urllib.parse.quote)
    else:
        # 2.0.1. The axes are named by the coverage, not by us (`axes`), and the
        # box is in the coverage's own CRS: asking GeoServer to reproject as
        # well is one more thing to be refused, and rasterio warps it here.
        #
        # `scalesize` names the grid's axes, not the CRS's: E and N subset a
        # Swiss coverage, and i and j are what can be scaled. With no scale
        # axes at all the coverage is asked for unscaled and resampled here.
        first, second = axes or ("E", "N")
        fields = {
            "service": "WCS", "version": version, "request": "GetCoverage",
            "coverageId": coverage_id, "format": "image/tiff",
        }
        if scale_axes:
            si, sj = scale_axes
            fields["scalesize"] = f"{si}({size}),{sj}({size})"
        query = (urllib.parse.urlencode(fields, quote_via=urllib.parse.quote)
                 + f"&subset={first}({west},{east})&subset={second}({south},{north})")
    return f"{service_url(base, 'wcs')}?{query}"



def probe(base: str, user: str | None, password: str | None) -> dict:
    """What this GeoServer has: its rasters, and its vector layers if any.

    Neither half is allowed to hide the other. The Setup panel asks this to
    offer the ground (TASKS-usable T0), which is a coverage — and a GeoServer
    where somebody has published their elevation and nothing else lists no WFS
    layers at all, which is not an error and must not read like one.
    """
    auth = _auth_header(user, password)
    result: dict = {"wfs": service_url(base, "wfs"), "layers": [], "coverages": []}
    for key, fetch in (("layers", feature_types), ("coverages", coverages)):
        try:
            result[key] = fetch(base, auth)
        except SystemExit as err:
            result[f"{key}_error"] = str(err)
    if not result["layers"] and not result["coverages"]:
        return {"error": result.get("coverages_error") or result.get("layers_error")
                or "connected, but this GeoServer publishes nothing"}
    return result
