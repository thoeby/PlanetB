"""Copy features out of a file and paste them into the player's layer.

TASKS-foundation.md FND.0, the harness: this is what a QGIS user does with an
OSM extract — open the file, select what is inside their land, copy, paste
into their own editable layer, fill the attribute form by the obvious field
mapping, save. Nothing here reaches past the layers the project gives the
player, so RLS decides the outcome exactly as it does for a drawn feature.

    python3.12 import.py <project.qgs> <json>

where <json> is
    {"layer": "Highway",                  the layer in the player's project
     "gpkg": "infra/seed/osm-visp.gpkg",  the file being copied from
     "source_layer": "lines",             the layer inside it
     "filter": "highway IS NOT NULL",     a QGIS expression, or null for all
     "into": {"highway": "highway", "lit": "lit"}}
                                          target field ← source field

It prints one JSON object: what was pasted, or the sentence QGIS would have
put in the message bar.
"""
from __future__ import annotations

import json
import sys

from qgis.core import (QgsApplication, QgsFeature, QgsProject, QgsVectorLayer)

from draw import layer_named

MULTI = (4, 5, 6)   # MultiPoint, MultiLineString, MultiPolygon


def source_of(ask: dict) -> QgsVectorLayer:
    uri = ask["gpkg"]
    if ask.get("source_layer"):
        uri = f'{uri}|layername={ask["source_layer"]}'
    return QgsVectorLayer(uri, "source", "ogr")


def paste(project: QgsProject, ask: dict) -> dict:
    target = layer_named(project, ask["layer"])
    if target is None:
        return {"ok": False, "error": f"no layer called {ask['layer']}",
                "layers": [lyr.name() for lyr in project.mapLayers().values()]}
    source = source_of(ask)
    if not source.isValid():
        return {"ok": False, "error": f"{ask['gpkg']} would not open: "
                                      f"{source.dataProvider().error().message()}"}

    picked = list(source.getFeatures(ask["filter"]) if ask.get("filter")
                  else source.getFeatures())
    if not picked:
        return {"ok": False, "error": "nothing is selected", "selected": 0}

    if not target.startEditing():
        return {"ok": False, "error": f"{ask['layer']} is not editable"}

    mapping = ask.get("into") or {}
    made = []
    for feature in picked:
        new = QgsFeature(target.fields())
        geometry = feature.geometry()
        if target.wkbType() in MULTI and not geometry.isMultipart():
            geometry.convertToMultiType()
        new.setGeometry(geometry)
        for to, frm in mapping.items():
            value = feature[frm] if frm in feature.fields().names() else frm
            if value is not None and str(value) != 'NULL':
                new.setAttribute(to, value)
        made.append(new)

    if not target.addFeatures(made):
        target.rollBack()
        return {"ok": False, "error": "QGIS would not take those features",
                "selected": len(picked)}
    if not target.commitChanges():
        said = "; ".join(target.commitErrors())
        target.rollBack()
        return {"ok": False, "error": said, "selected": len(picked)}
    return {"ok": True, "layer": ask["layer"], "pasted": len(made),
            "count": target.featureCount()}


def main(argv: list[str]) -> int:
    project_path, payload = argv[0], json.loads(argv[1])
    asks = payload if isinstance(payload, list) else [payload]

    QgsApplication.setPrefixPath("/usr", True)
    app = QgsApplication([], False)
    app.initQgis()
    try:
        project = QgsProject.instance()
        if not project.read(project_path):
            print(json.dumps({"ok": False,
                              "error": f"QGIS could not open {project_path}"}))
            return 1
        worst = 0
        for ask in asks:
            result = paste(project, ask)
            print(json.dumps(result))
            worst = worst or (0 if result["ok"] else 1)
        return worst
    finally:
        app.exitQgis()


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
