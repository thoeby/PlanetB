"""PNG in and PNG out, in the standard library.

TASKS-foundation.md FND.12. A cover source reaches the world as a class raster
over WMS, and where the source with the first claim on a tile has nothing, the
next one fills in. That is a pixel copy — this file copies pixels.

Invariant 9 and 10: nothing here reads a class, decides anything about the
world, or wants a library. It unpacks a PNG into RGBA bytes, puts one image
under another where the upper one is transparent, and packs RGBA bytes back
into a PNG. `zlib` and `struct` are all it takes.
"""
from __future__ import annotations

import struct
import zlib

MAGIC = b"\x89PNG\r\n\x1a\n"


class NotAPng(Exception):
    """These bytes are not a PNG this can read, and why."""


def chunks(data: bytes):
    """Every chunk of a PNG, as (kind, payload)."""
    if not data.startswith(MAGIC):
        raise NotAPng("no PNG signature")
    at = len(MAGIC)
    while at + 8 <= len(data):
        (size,) = struct.unpack(">I", data[at:at + 4])
        kind = data[at + 4:at + 8]
        payload = data[at + 8:at + 8 + size]
        yield kind, payload
        at += 12 + size


def _unfilter(raw: bytes, width: int, height: int, stride: int) -> bytearray:
    """The five PNG filters, undone, one scanline at a time."""
    out = bytearray(width * height * stride)
    prev = bytearray(width * stride)
    at = 0
    for y in range(height):
        kind = raw[at]
        at += 1
        line = bytearray(raw[at:at + width * stride])
        at += width * stride
        for i in range(len(line)):
            a = line[i - stride] if i >= stride else 0
            b = prev[i]
            c = prev[i - stride] if i >= stride else 0
            if kind == 1:
                line[i] = (line[i] + a) & 0xFF
            elif kind == 2:
                line[i] = (line[i] + b) & 0xFF
            elif kind == 3:
                line[i] = (line[i] + ((a + b) >> 1)) & 0xFF
            elif kind == 4:
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                near = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[i] = (line[i] + near) & 0xFF
            elif kind != 0:
                raise NotAPng(f"filter {kind} is not one of the five")
        out[y * width * stride:(y + 1) * width * stride] = line
        prev = line
    return out


# How many bytes a pixel is, per PNG colour type. 16-bit samples and
# interlacing are not here because no WMS sends them for a map tile; either
# raises rather than being guessed at.
CHANNELS = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}


def decode(data: bytes) -> tuple[int, int, bytearray]:
    """One PNG as (width, height, RGBA bytes)."""
    width = height = depth = colour = 0
    body = bytearray()
    palette = b""
    alpha = b""
    for kind, payload in chunks(data):
        if kind == b"IHDR":
            width, height, depth, colour, _, _, lace = struct.unpack(">IIBBBBB", payload)
            if depth != 8:
                raise NotAPng(f"{depth}-bit samples, and this reads 8")
            if lace:
                raise NotAPng("interlaced")
            if colour not in CHANNELS:
                raise NotAPng(f"colour type {colour}")
        elif kind == b"PLTE":
            palette = payload
        elif kind == b"tRNS":
            alpha = payload
        elif kind == b"IDAT":
            body += payload
        elif kind == b"IEND":
            break
    if not width or not height:
        raise NotAPng("no IHDR")
    stride = CHANNELS[colour]
    flat = _unfilter(zlib.decompress(bytes(body)), width, height, stride)
    return width, height, _to_rgba(flat, width * height, colour, palette, alpha)


def _to_rgba(flat: bytearray, pixels: int, colour: int,
             palette: bytes, alpha: bytes) -> bytearray:
    out = bytearray(pixels * 4)
    for i in range(pixels):
        if colour == 6:
            out[i * 4:i * 4 + 4] = flat[i * 4:i * 4 + 4]
        elif colour == 2:
            out[i * 4:i * 4 + 3] = flat[i * 3:i * 3 + 3]
            out[i * 4 + 3] = 255
        elif colour == 3:
            k = flat[i]
            out[i * 4:i * 4 + 3] = palette[k * 3:k * 3 + 3] or b"\0\0\0"
            out[i * 4 + 3] = alpha[k] if k < len(alpha) else 255
        elif colour == 0:
            out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = flat[i]
            out[i * 4 + 3] = 255
        else:  # 4: grey + alpha
            out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = flat[i * 2]
            out[i * 4 + 3] = flat[i * 2 + 1]
    return out


def encode(width: int, height: int, rgba: bytes) -> bytes:
    """RGBA bytes as an 8-bit RGBA PNG, every scanline unfiltered."""
    rows = bytearray()
    for y in range(height):
        rows += b"\0" + rgba[y * width * 4:(y + 1) * width * 4]

    def chunk(kind: bytes, payload: bytes) -> bytes:
        return (struct.pack(">I", len(payload)) + kind + payload
                + struct.pack(">I", zlib.crc32(kind + payload) & 0xFFFFFFFF))

    return (MAGIC
            + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(bytes(rows), 6))
            + chunk(b"IEND", b""))


def under(top: bytes, lower: bytes) -> bytearray:
    """`lower` showing wherever `top` is fully transparent.

    Not alpha blending: a class raster's pixel is a class or it is nothing, and
    a half-mixed colour would be a class nobody mapped. Both must be the same
    size, which they are — the server asks every source for the same tile.
    """
    if len(top) != len(lower):
        raise NotAPng("two cover tiles of different sizes")
    out = bytearray(top)
    for i in range(3, len(out), 4):
        if out[i] == 0:
            out[i - 3:i + 1] = lower[i - 3:i + 1]
    return out
