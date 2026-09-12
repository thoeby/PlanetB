"""What the Setup panel asks a GeoServer, against a GeoServer made of strings.

TASKS-usable T0: the ground is a coverage somebody picks out of their own
GeoServer. A world where the elevation has been published and nothing else has
lists no WFS layers at all — normal, and it must not read as a failure or hide
the coverage that is there.
"""
from __future__ import annotations

import http.server
import threading
import unittest

from splatworld import geoserver

WCS_10 = b"""<?xml version="1.0"?>
<WCS_Capabilities xmlns="http://www.opengis.net/wcs" version="1.0.0">
 <ContentMetadata>
  <CoverageOfferingBrief>
   <name>ch:alti</name><label>Swiss elevation</label>
   <lonLatEnvelope srsName="urn:ogc:def:crs:OGC:1.3:CRS84">
     <pos>5.9 45.8</pos><pos>10.5 47.8</pos>
   </lonLatEnvelope>
  </CoverageOfferingBrief>
 </ContentMetadata>
</WCS_Capabilities>"""

WFS_EMPTY = b"""<?xml version="1.0"?>
<WFS_Capabilities xmlns="http://www.opengis.net/wfs" version="2.0.0">
  <FeatureTypeList/>
</WFS_Capabilities>"""

NOTHING = b"""<?xml version="1.0"?><ows:ExceptionReport
 xmlns:ows="http://www.opengis.net/ows"><ows:Exception><ows:ExceptionText>
 Service WCS is disabled</ows:ExceptionText></ows:Exception></ows:ExceptionReport>"""


def serve(bodies: dict[str, bytes]):
    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802 - http.server's name
            body = bodies["wcs" if "/wcs" in self.path else "wfs"]
            self.send_response(200)
            self.send_header("Content-Type", "text/xml")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args):
            pass

    srv = http.server.HTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, f"http://127.0.0.1:{srv.server_address[1]}/geoserver"


class ProbeTest(unittest.TestCase):
    def test_a_geoserver_with_only_elevation_still_offers_it(self):
        srv, base = serve({"wcs": WCS_10, "wfs": WFS_EMPTY})
        try:
            out = geoserver.probe(base, None, None)
        finally:
            srv.shutdown()
        self.assertNotIn("error", out)
        self.assertEqual([c["id"] for c in out["coverages"]], ["ch:alti"])
        self.assertEqual(out["coverages"][0]["bbox"], [5.9, 45.8, 10.5, 47.8])
        self.assertEqual(out["coverages"][0]["title"], "Swiss elevation")
        self.assertIn("layers_error", out)

    def test_a_geoserver_publishing_nothing_says_so_once(self):
        srv, base = serve({"wcs": NOTHING, "wfs": WFS_EMPTY})
        try:
            out = geoserver.probe(base, None, None)
        finally:
            srv.shutdown()
        self.assertIn("error", out)
        self.assertNotIn("coverages", out)


if __name__ == "__main__":
    unittest.main()


WCS_20 = b"""<?xml version="1.0"?>
<Capabilities xmlns="http://www.opengis.net/wcs/2.0"
              xmlns:ows="http://www.opengis.net/ows/2.0" version="2.0.1">
 <Contents><CoverageSummary>
   <CoverageId>splatworld__dem</CoverageId>
   <ows:BoundingBox crs="EPSG:2056">
     <ows:LowerCorner>2633000 1124000</ows:LowerCorner>
     <ows:UpperCorner>2640000 1130000</ows:UpperCorner>
   </ows:BoundingBox>
   <ows:WGS84BoundingBox>
     <ows:LowerCorner>7.80 46.20</ows:LowerCorner>
     <ows:UpperCorner>7.90 46.30</ows:UpperCorner>
   </ows:WGS84BoundingBox>
 </CoverageSummary></Contents>
</Capabilities>"""

WCS_20_NATIVE_ONLY = WCS_20.replace(b"ows:WGS84BoundingBox", b"ows:OtherBoundingBox")


class ExtentTest(unittest.TestCase):
    """A coverage in LV95 publishes its own envelope in metres first."""

    def test_the_wgs84_envelope_is_the_one_taken(self):
        srv, base = serve({"wcs": WCS_20, "wfs": WFS_EMPTY})
        try:
            found = geoserver.coverages(base, {})
        finally:
            srv.shutdown()
        self.assertEqual(found[0]["bbox"], [7.8, 46.2, 7.9, 46.3])

    def test_an_envelope_in_metres_is_not_offered_as_lon_lat(self):
        srv, base = serve({"wcs": WCS_20_NATIVE_ONLY, "wfs": WFS_EMPTY})
        try:
            found = geoserver.coverages(base, {})
        finally:
            srv.shutdown()
        # Listed, because it exists; without an extent, because it has none we
        # can use. The Setup panel only offers coverages that have one.
        self.assertIsNone(found[0]["bbox"])
