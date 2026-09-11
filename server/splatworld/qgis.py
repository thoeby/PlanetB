"""The QGIS project, written from the world's own vocabulary.

TASKS-usable T2: `gis/splatworld.qgs` holds a layer per thing people draw, over
WFS-T against the operator's GeoServer, with a form on each layer showing the
properties an admin defined and a dropdown wherever they listed the values.

It is generated rather than hand-kept because the vocabulary is not ours to fix:
`splatworld qgis` rewrites the file from `gis_layers()`, so a kind added this
morning is a layer this afternoon. The file itself is committed, because opening
a project should not require running anything first.
"""
from __future__ import annotations

import hashlib
import xml.etree.ElementTree as ET
from pathlib import Path

import psycopg

from .config import Config

# QGIS writes the version it saved with; it opens anything from 3.x.
QGIS_VERSION = "3.34.0-Prizren"

WGS84_WKT = (
    'GEOGCRS["WGS 84",DATUM["World Geodetic System 1984",'
    'ELLIPSOID["WGS 84",6378137,298.257223563]],'
    'PRIMEM["Greenwich",0],CS[ellipsoidal,2],'
    'AXIS["geodetic latitude (Lat)",north],AXIS["geodetic longitude (Lon)",east],'
    'ANGLEUNIT["degree",0.0174532925199433],ID["EPSG",4326]]'
)

GEOMETRY_NAMES = {"polygon": "Polygon", "line": "Line", "point": "Point"}


def _sub(parent, tag, text=None, **attrs):
    node = ET.SubElement(parent, tag, {k: str(v) for k, v in attrs.items()})
    if text is not None:
        node.text = text
    return node


def crs(parent, tag: str = "srs"):
    holder = _sub(parent, tag)
    srs = _sub(holder, "spatialrefsys")
    _sub(srs, "wkt", WGS84_WKT)
    _sub(srs, "proj4", "+proj=longlat +datum=WGS84 +no_defs")
    _sub(srs, "srsid", "3452")
    _sub(srs, "srid", "4326")
    _sub(srs, "authid", "EPSG:4326")
    _sub(srs, "description", "WGS 84")
    _sub(srs, "projectionacronym", "longlat")
    _sub(srs, "ellipsoidacronym", "EPSG:7030")
    _sub(srs, "geographicflag", "true")
    return holder


def wfs_source(wfs_url: str, layer: str) -> str:
    """What QGIS needs to open one WFS-T layer.

    WFS 1.0.0 on purpose: in 1.1 and 2.0 QGIS and GeoServer disagree about which
    of the two numbers in EPSG:4326 comes first, and everything drawn ends up in
    the Indian Ocean. gis/README.md says the same thing about the connection.
    """
    return (f"pagingEnabled='false' preferCoordinatesForWfsT11='false' "
            f"restrictToRequestBBOX='1' srsname='EPSG:4326' "
            f"typename='splatworld:{layer}' url='{wfs_url}' version='1.0.0'")


def value_map(field, choices: list[str]) -> None:
    """A dropdown of exactly the values the admin listed."""
    widget = _sub(field, "editWidget", type="ValueMap")
    config = _sub(widget, "config")
    options = _sub(config, "Option", type="Map")
    values = _sub(options, "Option", name="map", type="List")
    for choice in choices:
        entry = _sub(values, "Option", type="Map")
        _sub(entry, "Option", name=choice, value=choice, type="QString")


def field_config(layer_node, fields: list[dict]) -> None:
    configuration = _sub(layer_node, "fieldConfiguration")
    aliases = _sub(layer_node, "aliases")
    constraints = _sub(layer_node, "constraints")
    for index, field in enumerate(fields):
        node = _sub(configuration, "field", name=field["name"], configurationFlags="None")
        if field["type"] == "choice" and field.get("choices"):
            value_map(node, list(field["choices"]))
        else:
            kind = {"number": "Range", "boolean": "CheckBox"}.get(field["type"], "TextEdit")
            widget = _sub(node, "editWidget", type=kind)
            _sub(widget, "config")
        _sub(aliases, "alias", field=field["name"], name=field["label"], index=index)
        _sub(constraints, "constraint", field=field["name"],
             constraints=1 if field.get("required") else 0,
             notnull_strength=1 if field.get("required") else 0,
             unique_strength=0, exp_strength=0)


def map_layer(parent, layer: dict, wfs_url: str) -> str:
    # A stable id: Python's hash() is salted per process, and a project file
    # that changes on every run is not a file anybody can keep in a repo.
    digest = hashlib.md5(layer["layer"].encode()).hexdigest()[:12]
    ident = f"{layer['layer']}_{digest}"
    node = _sub(parent, "maplayer", type="vector", hasScaleBasedVisibilityFlag="0",
                geometry=GEOMETRY_NAMES.get(layer["geometry"], "Polygon"),
                readOnly="0")
    _sub(node, "id", ident)
    _sub(node, "datasource", wfs_source(wfs_url, layer["layer"]))
    _sub(node, "layername", layer["label"])
    crs(node)
    _sub(node, "provider", "WFS", encoding="UTF-8")
    field_config(node, layer.get("fields") or [])
    return ident


def raster_layer(parent, wms_url: str, coverage: str) -> str:
    """The ground, as a picture to draw on: the same coverage, over WMS."""
    ident = "ground_hillshade"
    node = _sub(parent, "maplayer", type="raster", hasScaleBasedVisibilityFlag="0")
    _sub(node, "id", ident)
    _sub(node, "datasource",
         f"crs=EPSG:4326&format=image/png&layers={coverage}&styles=&url={wms_url}")
    _sub(node, "layername", f"Ground ({coverage})")
    crs(node)
    _sub(node, "provider", "wms")
    return ident


def project_xml(layers: list[dict], wfs_url: str, wms_url: str,
                coverage: str | None) -> bytes:
    root = ET.Element("qgis", {"projectname": "splatworld", "version": QGIS_VERSION})
    _sub(root, "homePath", path="")
    _sub(root, "title", "splatworld")
    crs(root, "projectCrs")

    tree = _sub(root, "layer-tree-group")
    project_layers = _sub(root, "projectlayers")
    order = _sub(root, "layerorder")

    entries: list[tuple[str, str, str]] = []
    for layer in layers:
        ident = map_layer(project_layers, layer, wfs_url)
        entries.append((ident, layer["label"], wfs_source(wfs_url, layer["layer"])))
    for name, layer_name in (("Your land", "area"), ("Placed", "instance"),
                             ("Tiles", "tile")):
        ident = map_layer(project_layers,
                          {"layer": layer_name, "label": name, "geometry": "polygon",
                           "fields": []}, wfs_url)
        entries.append((ident, name, wfs_source(wfs_url, layer_name)))
    if coverage:
        ident = raster_layer(project_layers, wms_url, coverage)
        entries.append((ident, f"Ground ({coverage})", ""))

    # Drawing order is the order they are listed: the ground underneath.
    for ident, name, source in entries:
        _sub(tree, "layer-tree-layer", id=ident, name=name, source=source,
             providerKey="WFS" if source else "wms", checked="Qt::Checked",
             expanded="1")
        _sub(order, "layer", id=ident)

    ET.indent(root, space="  ")
    return (b'<?xml version="1.0" encoding="UTF-8"?>\n'
            + ET.tostring(root, encoding="utf8", xml_declaration=False))


def write(cfg: Config, out: Path | None = None) -> Path:
    """Rewrites gis/splatworld.qgs from what the world says it holds."""
    target = out or (cfg.repo / "gis" / "splatworld.qgs")
    with psycopg.connect(cfg.dsn(), autocommit=True) as conn:
        layers = conn.execute("SELECT gis_layers()").fetchone()[0]
        row = conn.execute("SELECT geoserver_url, coverage FROM ground").fetchone()
    base = (row[0] if row else cfg.geoserver_url) or "http://localhost:8080/geoserver"
    base = base.rstrip("/")
    if not base.startswith("http"):
        base = f"http://{base}"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(project_xml(layers, f"{base}/splatworld/wfs",
                                   f"{base}/wms", row[1] if row else None))
    return target
