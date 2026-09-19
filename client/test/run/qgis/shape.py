"""Shape the ground in QGIS, the way a raster-editing plugin does.

TASKS-foundation.md FND.10. The project the page downloaded carries a
"Ground shaping (m)" layer per land, read from the world's GeoTIFF view of
that land's own `.r32` (server/splatworld/geotiff.py). This opens it, adds
metres to a block of its cells the way a plugin would, and sends it back with
the script the project ships (gis/save-ground.py) — which is what the player
would press.

    python3.12 shape.py <project.qgs> <json>

where <json> is {"area": "<uuid>", "world": "http://…", "email": …,
                 "password": …, "add": 3.0,
                 "block": null | "middle" | [west, south, east, north],
                 "save_as": "<uuid>"}.

It prints one JSON object: what the layer held, what was written, and what the
world said about the save.
"""
from __future__ import annotations

import importlib.util
import json
import sys
import urllib.request
from pathlib import Path

from qgis.core import QgsApplication, QgsProject


def script_from(world: str):
    """The save script, downloaded from the world exactly as a player gets it."""
    target = Path("/tmp/save_ground.py")
    with urllib.request.urlopen(f"{world}/qgis/save-ground.py", timeout=30) as res:
        target.write_bytes(res.read())
    spec = importlib.util.spec_from_file_location("save_ground", target)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def shaping_layer(project: QgsProject, area: str):
    """The land's own shaping layer, found by the file it reads.

    Every land has one and they are all called "Ground shaping (m) · <land>";
    which land a layer is about is in its source, which is exact.
    """
    for layer in project.mapLayers().values():
        if area in layer.source() and layer.name().startswith("Ground shaping"):
            return layer
    return None


class Edited:
    """The raster as the plugin left it: the same grid, some cells higher.

    It answers `dataProvider()`, `width()` and `height()` the way a QGIS raster
    layer does, because that is all the save script asks of one.
    """

    def __init__(self, layer, add, block):
        provider = layer.dataProvider()
        self._extent = provider.extent()
        self._w, self._h = layer.width(), layer.height()
        got = provider.block(1, self._extent, self._w, self._h)
        self.cells = []
        for row in range(self._h):
            for col in range(self._w):
                v = got.value(row, col)
                v = 0.0 if v != v else float(v)
                if self._inside(row, col, block):
                    v += add
                self.cells.append(v)

    def _inside(self, row, col, block):
        """Whether this cell is in the block being raised.

        `null` is the whole layer; "middle" is the middle quarter of it, which
        is a block inside the land wherever the land is.
        """
        if block is None:
            return True
        if block == "middle":
            e = self._extent
            west = e.xMinimum() + e.width() * 0.375
            east = e.xMinimum() + e.width() * 0.625
            south = e.yMinimum() + e.height() * 0.375
            north = e.yMinimum() + e.height() * 0.625
        else:
            west, south, east, north = block
        x = (self._extent.xMinimum()
             + (col + 0.5) / self._w * self._extent.width())
        y = (self._extent.yMaximum()
             - (row + 0.5) / self._h * self._extent.height())
        return west <= x <= east and south <= y <= north

    def width(self):
        return self._w

    def height(self):
        return self._h

    def dataProvider(self):  # noqa: N802 - QGIS's own spelling
        return self

    def extent(self):
        return self._extent

    def block(self, _band, _extent, _w, _h):
        return self

    def value(self, row, col):
        return self.cells[row * self._w + col]


def run(project_path: str, ask: dict) -> dict:
    app = QgsApplication([], False)
    app.initQgis()
    try:
        project = QgsProject.instance()
        if not project.read(project_path):
            return {"ok": False, "error": f"QGIS would not open {project_path}"}
        layer = shaping_layer(project, ask["area"])
        if layer is None or not layer.isValid():
            return {"ok": False, "error": "no ground shaping layer for that land",
                    "layers": [q.name() for q in project.mapLayers().values()]}
        edited = Edited(layer, float(ask.get("add", 0)), ask.get("block"))
        save = script_from(ask["world"])
        # `save_as` is how a story sends this land's raster to another land:
        # the world is the one that refuses it, and that is the point.
        said = save.save(edited, ask.get("save_as") or ask["area"], ask["world"],
                         ask["email"], ask["password"])
        return {"width": layer.width(), "height": layer.height(),
                "highest": max(edited.cells), **said}
    finally:
        app.exitQgis()


if __name__ == "__main__":
    print(json.dumps(run(sys.argv[1], json.loads(sys.argv[2]))))
