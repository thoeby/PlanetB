"""Save ground shaping to splatworld.

FND.10. QGIS cannot write into this world's file store: the store takes a PUT
with a bearer token and a declared sha256 (`can_write`, db/0163), and a raster
provider knows nothing about either. So the shaping you edited in QGIS is sent
by this script, which does exactly what the page's Shape panel does — writes
one immutable `.r32` and calls `save_height_edit` — as you.

It is a plain script rather than a Processing algorithm because headless QGIS
runs a plain script and nothing else is needed: see docs/manual.md.

    from save_ground import save
    save(layer, area_id, world="http://localhost:8080",
         email="ben@example.com", password="…")

`layer` is the "Ground shaping (m)" raster as QGIS holds it, after whatever
was done to it. Every cell outside your own land is refused by the world, and
this says so rather than pretending.
"""

from __future__ import annotations

import json
import struct
import urllib.error
import urllib.request
from hashlib import sha256


def read_layer(layer):
    """The raster's cells and where it is, from QGIS's own provider."""
    provider = layer.dataProvider()
    extent = provider.extent()
    width, height = layer.width(), layer.height()
    block = provider.block(1, extent, width, height)
    cells = [block.value(row, col) for row in range(height) for col in range(width)]
    return {
        "bbox": [extent.xMinimum(), extent.yMinimum(),
                 extent.xMaximum(), extent.yMaximum()],
        "width": width, "height": height,
        "cells": [0.0 if v != v else float(v) for v in cells],
    }


def write_r32(grid) -> bytes:
    """docs/rendering.md §6, byte for byte as client/lib/r32.js writes it."""
    head = json.dumps({
        "version": "r32-v1", "bbox": [float(v) for v in grid["bbox"]],
        "cell": float(grid.get("cell", 0)), "width": grid["width"],
        "height": grid["height"],
    })
    head += " " * (-len(head) % 4)
    body = struct.pack(f"<{len(grid['cells'])}f", *grid["cells"])
    return b"R32\0" + struct.pack("<I", len(head)) + head.encode() + body


def api_of(world):
    """Where this world answers questions, as its own page says.

    The file store and the API are two addresses (`splatworld:files` and
    `splatworld:api` in every page of client/), and the page reads them off
    itself. So does this.
    """
    import re

    with urllib.request.urlopen(f"{world}/app/play.html", timeout=30) as res:
        page = res.read().decode("utf8", "replace")
    found = re.search(r'name="splatworld:api" content="([^"]+)"', page)
    return found[1].rstrip("/") if found else world


def _post(url, body, token=None):
    req = urllib.request.Request(
        url, data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"}, method="POST")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    with urllib.request.urlopen(req, timeout=30) as res:
        raw = res.read()
    return json.loads(raw) if raw else None


def login(api, email, password):
    """A token of your own, the way the page gets one."""
    said = _post(f"{api}/rpc/login", {"email": email, "pw": password})
    return said["token"] if isinstance(said, dict) else said


def save(layer, area_id, world, email, password, cell=0.0):
    """Sends what is in the layer. Returns what the world said."""
    grid = read_layer(layer)
    grid["cell"] = cell or (grid["bbox"][2] - grid["bbox"][0]) / max(1, grid["width"])
    bytes_ = write_r32(grid)
    digest = sha256(bytes_).hexdigest()
    api = api_of(world)
    token = login(api, email, password)

    put = urllib.request.Request(
        f"{world}/assets/{digest}.r32", data=bytes_, method="PUT",
        headers={"X-Sha256": digest, "Authorization": f"Bearer {token}",
                 "Content-Type": "application/octet-stream"})
    try:
        with urllib.request.urlopen(put, timeout=60):
            pass
        _post(f"{api}/rpc/register_artifact",
              {"sha256": digest, "kind": "height_edit", "bytes": len(bytes_),
               "algo_version": "r32-v1"}, token)
    except urllib.error.HTTPError as err:
        # 409 is the store already holding these bytes, which is not an error
        # (Invariant 1); anything else is.
        if err.code not in (403, 409):
            raise

    rev = _post(f"{api}/rpc/height_edit_rev", {"area": area_id}, token)
    try:
        said = _post(f"{api}/rpc/save_height_edit",
                     {"area": area_id, "sha256": digest, "rev": rev or 0}, token)
    except urllib.error.HTTPError as err:
        body = json.loads(err.read() or b"{}")
        return {"ok": False, "error": body.get("message", str(err))}
    return {"ok": True, **(said or {})}
