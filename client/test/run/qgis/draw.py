"""Draw in QGIS, the way a person does: open the project, edit a layer, save.

PLAYER-RUN.md, "The harness": headless QGIS opens the project the page
downloaded for the player and performs edits through the layers exactly as a
user would — open layer, start editing, add feature with attributes, commit —
and errors are read from the provider's commit result, as QGIS would show them.

    python3.12 draw.py <project.qgs> <json>

where <json> is {"layer": "Forest", "geometry": "POLYGON((...))",
                 "attributes": {"leaf_type": "broadleaved"}}
or a list of those. It prints one JSON object per edit: what was added, or the
sentence QGIS would have put in the message bar.
"""
from __future__ import annotations

import json
import sys

from qgis.core import (QgsApplication, QgsFeature, QgsGeometry, QgsProject,
                       QgsVectorLayer)


def layer_named(project: QgsProject, name: str) -> QgsVectorLayer | None:
    for layer in project.mapLayers().values():
        if layer.name() == name:
            return layer
    return None


def draw(project: QgsProject, edit: dict) -> dict:
    layer = layer_named(project, edit["layer"])
    if layer is None:
        return {"ok": False, "error": f"no layer called {edit['layer']}",
                "layers": [layer.name() for layer in project.mapLayers().values()]}
    if not layer.isValid():
        return {"ok": False, "error": f"{edit['layer']} would not open: "
                                      f"{layer.dataProvider().error().message()}"}
    if not layer.startEditing():
        return {"ok": False, "error": f"{edit['layer']} is not editable"}

    feature = QgsFeature(layer.fields())
    geometry = QgsGeometry.fromWkt(edit["geometry"])
    if geometry.isNull():
        return {"ok": False, "error": f"that is not a geometry: {edit['geometry']}"}
    # The views are Multi*; a polygon typed as one is converted here, as the
    # digitising tools do.
    if layer.wkbType() in (6, 5) and not geometry.isMultipart():
        geometry.convertToMultiType()
    feature.setGeometry(geometry)
    for name, value in (edit.get("attributes") or {}).items():
        feature.setAttribute(name, value)
    if not layer.addFeature(feature):
        layer.rollBack()
        return {"ok": False, "error": "QGIS would not take that feature"}
    if not layer.commitChanges():
        # This is the message bar: what the provider said, in the words the
        # person would read.
        said = "; ".join(layer.commitErrors())
        layer.rollBack()
        return {"ok": False, "error": said}
    return {"ok": True, "layer": edit["layer"], "count": layer.featureCount()}


def main(argv: list[str]) -> int:
    project_path, payload = argv[0], json.loads(argv[1])
    edits = payload if isinstance(payload, list) else [payload]

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
        for edit in edits:
            result = draw(project, edit)
            print(json.dumps(result))
            worst = worst or (0 if result["ok"] else 1)
        return worst
    finally:
        app.exitQgis()


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
