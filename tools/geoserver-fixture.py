#!/usr/bin/env python3
"""A GeoServer's raster half, over one GeoTIFF, for boxes that cannot pull it.

`make player-run` wants what story 3.1 gives the operator: a GeoServer that
publishes their elevation as a coverage. The real one is a container
(`infra/compose.yml`), and that is what the operator runs. Where the container
registry is unreachable — an offline box, a sandbox with an egress policy —
this serves the same two conversations over `infra/seed/dem-visp.tif`:

  WCS 1.0.0   GetCapabilities / DescribeCoverage / GetCoverage  (the ground)
  WMS 1.3.0   GetCapabilities / GetMap                          (QGIS hillshade)

It answers nothing else. It is a stand-in for a service the player is given,
not for anything a player does: no story step touches it, and every story that
passes here passes against the container too or it is not passing.

    python3 tools/geoserver-fixture.py --tif infra/seed/dem-visp.tif --port 8081
"""
from __future__ import annotations

import argparse
import io
import sys
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from xml.sax.saxutils import escape

import rasterio
from rasterio.io import MemoryFile
from rasterio.transform import from_bounds
from rasterio.vrt import WarpedVRT

WCS_CAPS = """<?xml version="1.0" encoding="UTF-8"?>
<WCS_Capabilities version="1.0.0" xmlns="http://www.opengis.net/wcs"
    xmlns:gml="http://www.opengis.net/gml">
  <Service><name>splatworld-fixture</name><label>{label}</label></Service>
  <ContentMetadata>
    <CoverageOfferingBrief>
      <name>{name}</name>
      <label>{label}</label>
      <lonLatEnvelope srsName="urn:ogc:def:crs:OGC:1.3:CRS84">
        <gml:pos>{west} {south}</gml:pos>
        <gml:pos>{east} {north}</gml:pos>
      </lonLatEnvelope>
    </CoverageOfferingBrief>
  </ContentMetadata>
</WCS_Capabilities>
"""

WCS_DESCRIBE = """<?xml version="1.0" encoding="UTF-8"?>
<wcs:CoverageDescriptions xmlns:wcs="http://www.opengis.net/wcs/2.0"
    xmlns:gml="http://www.opengis.net/gml/3.2">
  <wcs:CoverageDescription gml:id="{name}">
    <gml:boundedBy>
      <gml:Envelope srsName="http://www.opengis.net/def/crs/EPSG/0/4326"
          axisLabels="Long Lat" uomLabels="deg deg" srsDimension="2">
        <gml:lowerCorner>{west} {south}</gml:lowerCorner>
        <gml:upperCorner>{east} {north}</gml:upperCorner>
      </gml:Envelope>
    </gml:boundedBy>
    <gml:domainSet>
      <gml:RectifiedGrid dimension="2" gml:id="{name}-grid">
        <gml:limits/>
        <gml:axisLabels>i j</gml:axisLabels>
      </gml:RectifiedGrid>
    </gml:domainSet>
  </wcs:CoverageDescription>
</wcs:CoverageDescriptions>
"""

WMS_CAPS = """<?xml version="1.0" encoding="UTF-8"?>
<WMS_Capabilities version="1.3.0" xmlns="http://www.opengis.net/wms">
  <Service><Name>WMS</Name><Title>{label}</Title></Service>
  <Capability>
    <Request><GetMap><Format>image/png</Format></GetMap></Request>
    <Layer>
      <Title>{label}</Title>
      <CRS>EPSG:4326</CRS><CRS>EPSG:3857</CRS>
      <Layer queryable="0">
        <Name>{name}</Name><Title>{label}</Title>
        <CRS>EPSG:4326</CRS><CRS>EPSG:3857</CRS>
        <EX_GeographicBoundingBox>
          <westBoundLongitude>{west}</westBoundLongitude>
          <eastBoundLongitude>{east}</eastBoundLongitude>
          <southBoundLatitude>{south}</southBoundLatitude>
          <northBoundLatitude>{north}</northBoundLatitude>
        </EX_GeographicBoundingBox>
      </Layer>
    </Layer>
  </Capability>
</WMS_Capabilities>
"""

EXCEPTION = """<?xml version="1.0" encoding="UTF-8"?>
<ServiceExceptionReport xmlns="http://www.opengis.net/ogc" version="1.2.0">
  <ServiceException code="{code}">{text}</ServiceException>
</ServiceExceptionReport>
"""


def lower(query: dict) -> dict:
    """OGC parameter names are case-insensitive; the callers spell them freely."""
    return {k.lower(): v[0] for k, v in query.items() if v}


class World:
    def __init__(self, path: str, name: str, label: str):
        self.path = path
        self.name = name
        self.label = label
        with rasterio.open(path) as src:
            self.bounds = tuple(src.bounds)
            self.crs = src.crs

    def fields(self) -> dict:
        west, south, east, north = self.bounds
        return {"name": escape(self.name), "label": escape(self.label),
                "west": west, "south": south, "east": east, "north": north}

    def window(self, bbox: tuple, crs_name: str, width: int, height: int) -> bytes:
        """Exactly this box, exactly this many samples, as a GeoTIFF."""
        west, south, east, north = bbox
        with rasterio.open(self.path) as src, WarpedVRT(
                src, crs=crs_name,
                transform=from_bounds(west, south, east, north, width, height),
                width=width, height=height,
                resampling=rasterio.enums.Resampling.bilinear) as vrt:
            band = vrt.read(1)
            profile = {"driver": "GTiff", "height": height, "width": width,
                       "count": 1, "dtype": band.dtype, "crs": crs_name,
                       "transform": from_bounds(west, south, east, north,
                                                width, height)}
            if src.nodata is not None:
                profile["nodata"] = src.nodata
            with MemoryFile() as mem:
                with mem.open(**profile) as dst:
                    dst.write(band, 1)
                return mem.read()

    def hillshade_png(self, bbox: tuple, crs_name: str, width: int, height: int) -> bytes:
        """The same window, shaded, so QGIS has something to draw under the land."""
        import numpy as np
        import zlib
        import struct

        with rasterio.open(self.path) as src, WarpedVRT(
                src, crs=crs_name,
                transform=from_bounds(*bbox, width, height),
                width=width, height=height,
                resampling=rasterio.enums.Resampling.bilinear) as vrt:
            z = vrt.read(1).astype("float64")
        dy, dx = np.gradient(z)
        shade = np.clip(0.65 + 0.35 * (dx - dy) / (np.hypot(dx, dy) + 1e-6), 0, 1)
        grey = (shade * 255).astype("uint8")
        rows = b"".join(b"\x00" + grey[r].tobytes() for r in range(height))
        def chunk(kind: bytes, data: bytes) -> bytes:
            return (struct.pack(">I", len(data)) + kind + data
                    + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF))
        head = struct.pack(">IIBBBBB", width, height, 8, 0, 0, 0, 0)
        return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", head)
                + chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b""))


def handler_for(world: World):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, fmt, *args):  # noqa: A003 - quiet unless asked
            if VERBOSE:
                sys.stderr.write("geoserver-fixture: " + fmt % args + "\n")

        def send(self, body: bytes, kind: str, status: int = 200) -> None:
            self.send_response(status)
            self.send_header("Content-Type", kind)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def xml(self, text: str, status: int = 200) -> None:
            self.send(text.encode("utf8"), "application/xml", status)

        def refuse(self, code: str, text: str) -> None:
            self.xml(EXCEPTION.format(code=code, text=escape(text)), 200)

        def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler's name
            parsed = urllib.parse.urlparse(self.path)
            q = lower(urllib.parse.parse_qs(parsed.query))
            service = (q.get("service") or "").upper()
            request = (q.get("request") or "").lower()
            version = q.get("version", "")
            if service == "WCS":
                return self.wcs(request, version, q)
            if service == "WMS":
                return self.wms(request, q)
            return self.refuse("InvalidParameterValue",
                               "this fixture serves WCS and WMS only")

        def wcs(self, request: str, version: str, q: dict) -> None:
            if request == "getcapabilities":
                if not version.startswith("1.0"):
                    return self.refuse(
                        "InvalidParameterValue",
                        f"Could not understand version:{version} — this fixture "
                        "speaks WCS 1.0.0")
                return self.xml(WCS_CAPS.format(**world.fields()))
            if request == "describecoverage":
                return self.xml(WCS_DESCRIBE.format(**world.fields()))
            if request == "getcoverage":
                return self.coverage(q)
            return self.refuse("OperationNotSupported", request)

        def coverage(self, q: dict) -> None:
            asked = q.get("coverage") or q.get("coverageid") or ""
            if asked.replace("__", ":", 1) != world.name:
                return self.refuse("CoverageNotDefined",
                                   f"no coverage named {asked}")
            try:
                bbox = tuple(float(v) for v in q["bbox"].split(",")[:4])
                width = int(q.get("width", 256))
                height = int(q.get("height", 256))
            except (KeyError, ValueError) as err:
                return self.refuse("MissingParameterValue", f"BBOX/WIDTH/HEIGHT: {err}")
            crs_name = q.get("crs") or q.get("response_crs") or "EPSG:4326"
            try:
                self.send(world.window(bbox, crs_name, width, height), "image/tiff")
            except Exception as err:  # noqa: BLE001 - the client shows what it said
                self.refuse("NoApplicableCode", str(err))

        def wms(self, request: str, q: dict) -> None:
            if request == "getcapabilities":
                return self.xml(WMS_CAPS.format(**world.fields()))
            if request != "getmap":
                return self.refuse("OperationNotSupported", request)
            try:
                bbox = tuple(float(v) for v in q["bbox"].split(",")[:4])
                width = int(q.get("width", 256))
                height = int(q.get("height", 256))
            except (KeyError, ValueError) as err:
                return self.refuse("MissingParameterValue", str(err))
            crs_name = q.get("crs") or q.get("srs") or "EPSG:3857"
            # WMS 1.3.0 hands EPSG:4326 in latitude, longitude order.
            if q.get("version", "").startswith("1.3") and crs_name.upper() == "EPSG:4326":
                bbox = (bbox[1], bbox[0], bbox[3], bbox[2])
            try:
                self.send(world.hillshade_png(bbox, crs_name, width, height), "image/png")
            except Exception as err:  # noqa: BLE001
                self.refuse("NoApplicableCode", str(err))

    return Handler


VERBOSE = False


def main(argv: list[str]) -> int:
    global VERBOSE
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--tif", default="infra/seed/dem-visp.tif")
    ap.add_argument("--port", type=int, default=8081)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--name", default="splatworld:visp",
                    help="how the coverage is named in the capabilities")
    ap.add_argument("--label", default="Visp elevation (GLO-30)")
    ap.add_argument("--verbose", action="store_true")
    args = ap.parse_args(argv)
    VERBOSE = args.verbose

    world = World(args.tif, args.name, args.label)
    server = ThreadingHTTPServer((args.host, args.port), handler_for(world))
    west, south, east, north = world.bounds
    print(f"geoserver-fixture: http://{args.host}:{args.port}/geoserver"
          f" — {args.name} over {west:.4f},{south:.4f},{east:.4f},{north:.4f}",
          flush=True)
    server.serve_forever()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
