"""The QGIS project, written from the world's vocabulary (TASKS-usable T2).

No QGIS here, so what is asserted is the file: the layers it names, the version
of WFS it asks for, and that a property with values becomes a dropdown. Whether
QGIS likes it is a thing only QGIS can say — gis/README.md's checklist is where
that is ticked.
"""
from __future__ import annotations

import xml.etree.ElementTree as ET

from splatworld import qgis

LAYERS = [
    {"layer": "f_forest", "kind": "forest", "label": "Wood", "geometry": "polygon",
     "fields": [
         {"name": "leaf_type", "label": "Leaves", "type": "choice",
          "choices": ["broadleaved", "needleleaved"], "required": False},
         {"name": "density", "label": "Trees per hectare", "type": "number",
          "choices": [], "required": True},
     ]},
    {"layer": "f_road", "kind": "road", "label": "Road", "geometry": "line",
     "fields": []},
]


def project():
    raw = qgis.project_xml(LAYERS, "http://gs.example/splatworld/wfs",
                           "http://gs.example/wms", "ch:alti")
    return ET.fromstring(raw)


def test_every_kind_that_is_drawn_is_a_layer():
    names = [n.text for n in project().findall(".//maplayer/layername")]
    assert "Wood" in names and "Road" in names
    # And the three every world has, whatever its vocabulary.
    assert {"Your land", "Placed", "Tiles"} <= set(names)


def test_the_ground_is_in_it():
    root = project()
    raster = [m for m in root.findall(".//maplayer") if m.get("type") == "raster"]
    assert raster and "ch:alti" in raster[0].find("datasource").text


def test_wfs_one_zero_because_of_the_axis_order():
    for source in project().findall(".//maplayer/datasource"):
        if "typename" in (source.text or ""):
            assert "version='1.0.0'" in source.text


def test_a_property_with_values_becomes_a_dropdown():
    root = project()
    widget = root.find(".//field[@name='leaf_type']/editWidget")
    assert widget.get("type") == "ValueMap"
    offered = [o.get("name") for o in widget.iter("Option") if o.get("name")]
    assert "broadleaved" in offered and "needleleaved" in offered


def test_a_required_property_is_required_in_the_form():
    root = project()
    constraint = root.find(".//constraint[@field='density']")
    assert constraint.get("constraints") == "1"


def test_the_geometry_is_what_the_kind_is_drawn_as():
    root = project()
    for layer in root.findall(".//maplayer"):
        name = layer.find("layername").text
        if name == "Road":
            assert layer.get("geometry") == "Line"
        if name == "Wood":
            assert layer.get("geometry") == "Polygon"


def test_the_file_does_not_change_between_runs():
    assert qgis.project_xml(LAYERS, "u", "w", "c") == qgis.project_xml(LAYERS, "u", "w", "c")
