"""A fake GeoServer, so provisioning is tested rather than hoped for.

Everything this checks was a real failure: a store that already exists comes
back 500 rather than 409, a PUT that GeoServer accepts and then ignores leaves
the layers read-only, and the missing primary-key metadata table is what made
QGIS refuse to save with "{http://splatworld}area is read-only".

    python -m unittest discover -s server -p 'test_*.py'
"""
from __future__ import annotations

import json
import sys
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from splatworld import gsprovision  # noqa: E402


class FakeGeoServer(BaseHTTPRequestHandler):
    """Enough of GeoServer's REST and WFS to exercise the real code paths."""

    store: dict = {}
    keep_puts = True
    seen: list = []

    def log_message(self, *_):
        pass

    def _send(self, code: int, body: bytes = b"", kind="application/json"):
        self.send_response(code)
        self.send_header("Content-Type", kind)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _body(self) -> bytes:
        return self.rfile.read(int(self.headers.get("Content-Length") or 0))

    def do_POST(self):
        body = self._body()
        type(self).seen.append(("POST", self.path))
        if self.path.endswith("/datastores"):
            # What a real GeoServer answers for a store that is already there.
            self._send(500, b"Store 'splatworld_pg' already exists in workspace",
                       "text/plain")
            return
        self._send(201)

    def do_PUT(self):
        body = self._body()
        type(self).seen.append(("PUT", self.path))
        if self.path.endswith(f"/datastores/{gsprovision.STORE}"):
            if type(self).keep_puts:
                type(self).store = json.loads(body)
            self._send(200)
            return
        self._send(200)

    def do_GET(self):
        if self.path.endswith(f"/datastores/{gsprovision.STORE}.json"):
            self._send(200, json.dumps(type(self).store).encode())
        elif "request=GetCapabilities" in self.path or "/wfs?" in self.path and "GetFeature" not in self.path:
            self._send(200, CAPABILITIES, "text/xml")
        elif "GetFeature" in self.path:
            self._send(200, b'<wfs:FeatureCollection numberMatched="0"/>', "text/xml")
        else:
            self._send(404, b"not found", "text/plain")


CAPABILITIES = b"""<?xml version="1.0"?>
<WFS_Capabilities version="2.0.0" xmlns="http://www.opengis.net/wfs/2.0">
  <FeatureTypeList>
""" + b"".join(
    f"    <FeatureType><Name>splatworld:{n}</Name></FeatureType>\n".encode()
    for n in gsprovision.LAYERS
) + b"""  </FeatureTypeList>
</WFS_Capabilities>
"""


class Config:
    pg_port = 5432
    pg_database = "splatworld"
    pg_host = "localhost"
    geoserver_password = "secret"
    repo = Path(__file__).resolve().parents[1]


class ProvisionTest(unittest.TestCase):
    def setUp(self):
        FakeGeoServer.store = {}
        FakeGeoServer.keep_puts = True
        FakeGeoServer.seen = []
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), FakeGeoServer)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.server.server_port}"
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)

    def run_it(self):
        return gsprovision.provision(Config, self.url, "admin", "geoserver",
                                     on_step=lambda _: None)

    def test_existing_store_is_written_over_and_the_pk_table_lands(self):
        self.run_it()
        entries = FakeGeoServer.store["dataStore"]["connectionParameters"]["entry"]
        held = {e["@key"]: e["$"] for e in entries}
        self.assertEqual(held["Primary key metadata table"], "gis.gt_pk_metadata")
        self.assertEqual(held["schema"], "gis")
        self.assertIn(("PUT", f"/rest/workspaces/splatworld/datastores/"
                              f"{gsprovision.STORE}"), FakeGeoServer.seen)

    def test_the_cached_pools_are_dropped(self):
        self.run_it()
        self.assertIn(("POST", "/rest/reset"), FakeGeoServer.seen)

    def test_a_store_that_did_not_keep_the_settings_is_a_failure(self):
        FakeGeoServer.keep_puts = False
        with self.assertRaises(SystemExit) as caught:
            self.run_it()
        self.assertIn("read-only", str(caught.exception))


if __name__ == "__main__":
    unittest.main()
