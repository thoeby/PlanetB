"""geotiff.py — a land's shaped ground, as a raster QGIS can open.

FND.10. The world stores what somebody shaped as an `.r32`
(docs/rendering.md §6): a small JSON header and one float32 per cell. QGIS
opens rasters, not that. This turns one immutable file into another shape of
the same numbers — a format conversion and nothing else. It decides nothing
about the world and computes nothing about it (Invariant 9): the same bytes
in, the same bytes out, every time.

A plain single-strip GeoTIFF: little-endian, one float32 band, uncompressed,
with the three tags that say where on the earth it is. No GDAL, no numpy —
the server has the standard library and that is all it may have (Invariant 10).
"""

from __future__ import annotations

import json
import struct

from .crs import WORLD_SRID

# TIFF tag numbers, in the order they have to be written (ascending).
TAGS = {
    "ImageWidth": 256, "ImageLength": 257, "BitsPerSample": 258,
    "Compression": 259, "PhotometricInterpretation": 262, "StripOffsets": 273,
    "SamplesPerPixel": 277, "RowsPerStrip": 278, "StripByteCounts": 279,
    "PlanarConfiguration": 284, "SampleFormat": 339,
    "ModelPixelScale": 33550, "ModelTiepoint": 33922, "GeoKeyDirectory": 34735,
}
SHORT, LONG, DOUBLE = 3, 4, 12
SIZES = {SHORT: 2, LONG: 4, DOUBLE: 8}


def read_r32(data: bytes) -> dict:
    """The header and the cells of an .r32, as client/lib/r32.js writes them."""
    if data[:4] != b"R32\0":
        raise ValueError("not an r32 file")
    length = struct.unpack_from("<I", data, 4)[0]
    head = json.loads(data[8:8 + length])
    at = 8 + length
    count = head["width"] * head["height"]
    head["cells"] = data[at:at + count * 4]
    return head


def _entry(tag: int, kind: int, count: int, value: bytes, extra_at: int):
    """One IFD entry, and where its value lives when it does not fit in four."""
    if len(value) <= 4:
        return struct.pack("<HHI", tag, kind, count) + value.ljust(4, b"\0"), b"", 0
    return (struct.pack("<HHII", tag, kind, count, extra_at), value, len(value))


def write(head: dict) -> bytes:
    """A GeoTIFF of one .r32's cells, in WGS 84 degrees."""
    west, south, east, north = head["bbox"]
    w, h = head["width"], head["height"]
    # QGIS wants the scale as degrees per pixel and the tie point as the
    # north-west corner of the north-west pixel.
    scale = ((east - west) / max(1, w - 1), (north - south) / max(1, h - 1), 0.0)
    # The world's CRS is named once, in crs.py, and read from there.
    keys = (1, 1, 0, 3,
            1024, 0, 1, 2,             # GTModelTypeGeoKey = geographic
            1025, 0, 1, 1,             # GTRasterTypeGeoKey = pixel is area
            2048, 0, 1, WORLD_SRID)    # GeographicTypeGeoKey
    plan = [
        ("ImageWidth", LONG, 1, struct.pack("<I", w)),
        ("ImageLength", LONG, 1, struct.pack("<I", h)),
        ("BitsPerSample", SHORT, 1, struct.pack("<H", 32)),
        ("Compression", SHORT, 1, struct.pack("<H", 1)),
        ("PhotometricInterpretation", SHORT, 1, struct.pack("<H", 1)),
        ("StripOffsets", LONG, 1, b"\0\0\0\0"),
        ("SamplesPerPixel", SHORT, 1, struct.pack("<H", 1)),
        ("RowsPerStrip", LONG, 1, struct.pack("<I", h)),
        ("StripByteCounts", LONG, 1, struct.pack("<I", w * h * 4)),
        ("PlanarConfiguration", SHORT, 1, struct.pack("<H", 1)),
        ("SampleFormat", SHORT, 1, struct.pack("<H", 3)),
        ("ModelPixelScale", DOUBLE, 3, struct.pack("<3d", *scale)),
        ("ModelTiepoint", DOUBLE, 6, struct.pack("<6d", 0, 0, 0, west, north, 0)),
        ("GeoKeyDirectory", SHORT, len(keys), struct.pack(f"<{len(keys)}H", *keys)),
    ]
    ifd_at = 8
    ifd_len = 2 + 12 * len(plan) + 4
    extra_at = ifd_at + ifd_len
    extras: list[bytes] = []
    at = extra_at
    entries = []
    for name, kind, count, value in plan:
        if len(value) > 4:
            entries.append(struct.pack("<HHII", TAGS[name], kind, count, at))
            extras.append(value)
            at += len(value)
        else:
            entries.append(struct.pack("<HHI", TAGS[name], kind, count)
                           + value.ljust(4, b"\0"))
    strip_at = at
    # StripOffsets was written as a placeholder; now that the cells' place is
    # known, it is written again.
    for i, (name, _kind, _count, _value) in enumerate(plan):
        if name == "StripOffsets":
            entries[i] = (struct.pack("<HHI", TAGS[name], LONG, 1)
                          + struct.pack("<I", strip_at))
    out = bytearray(b"II" + struct.pack("<HI", 42, ifd_at))
    out += struct.pack("<H", len(plan))
    for e in entries:
        out += e
    out += struct.pack("<I", 0)
    for e in extras:
        out += e
    out += head["cells"]
    return bytes(out)


def of(data: bytes) -> bytes:
    """An .r32's bytes, as a GeoTIFF's."""
    return write(read_r32(data))
