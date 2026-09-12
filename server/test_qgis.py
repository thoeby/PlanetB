"""The QGIS project, written from the world's vocabulary.

What is asserted here is the file: the layers it names, that they are
PostgreSQL layers keyed on `id`, and that a property with values becomes a
dropdown. Whether QGIS likes it is a thing only QGIS can say — the player-run
opens it in a real headless QGIS and draws through it
(client/test/run/qgis/draw.py).
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


CONN = {"dbname": "splatworld", "host": "127.0.0.1", "port": 5432,
        "user": "p_0123456789ab", "password": "not-a-real-one"}


def project(conn=None):
    raw = qgis.project_xml(LAYERS, conn or CONN, "http://gs.example/wms", "ch:alti")
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


def test_the_layers_are_postgres_layers_keyed_on_id():
    root = project()
    vectors = [m for m in root.findall(".//maplayer") if m.get("type") == "vector"]
    assert vectors
    for layer in vectors:
        assert layer.find("provider").text == "postgres"
        source = layer.find("datasource").text
        # A view has no primary key to find, and the provider will not edit
        # one without being told which column identifies a row.
        assert "key='id'" in source
        assert 'table="gis"' in source
    # Nothing about this project speaks WFS any more.
    assert "typename" not in ET.tostring(root, encoding="unicode")


def test_the_committed_project_carries_nobody_s_password():
    root = project({"service": "splatworld"})
    for source in root.findall(".//maplayer/datasource"):
        assert "password" not in (source.text or "")
    assert "service='splatworld'" in (
        root.find(".//maplayer/datasource").text or "")


def test_land_and_tiles_are_there_to_look_at_not_to_edit():
    by_name = {m.find("layername").text: m
               for m in project().findall(".//maplayer")}
    assert by_name["Your land"].get("readOnly") == "1"
    assert by_name["Tiles"].get("readOnly") == "1"
    assert by_name["Wood"].get("readOnly") == "0"


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
    assert (qgis.project_xml(LAYERS, CONN, "w", "c")
            == qgis.project_xml(LAYERS, CONN, "w", "c"))


def test_a_piece_of_land_can_be_visited_from_qgis():
    """TASKS-usable T8: right-click the land, stand on it."""
    root = ET.fromstring(qgis.project_xml(
        LAYERS, CONN, "w", None, "http://host:8090/app/play.html"))
    land = [m for m in root.findall(".//maplayer")
            if m.find("layername").text == "Your land"][0]
    action = land.find(".//actionsetting")
    assert action.get("type") == "5", "an OpenUrl action, not a script"
    assert action.get("action").startswith("http://host:8090/app/play.html#at=")
    assert "centroid($geometry)" in action.get("action")


def test_the_action_is_only_on_the_land():
    root = ET.fromstring(qgis.project_xml(
        LAYERS, CONN, "w", None, "http://host:8090/app/play.html"))
    with_action = {m.find("layername").text for m in root.findall(".//maplayer")
                   if m.find(".//actionsetting") is not None}
    assert with_action == {"Your land"}
