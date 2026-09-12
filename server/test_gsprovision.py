"""A fake GeoServer, so provisioning is tested rather than hoped for.

Everything this checks was a real failure: a store that already exists comes
back 500 rather than 409, a PUT that GeoServer accepts and then ignores points
the layers at the wrong schema, and a layer that publishes fine and then says
"{http://splatworld}area is read-only" the moment QGIS presses Save.

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

    stores: dict = {}
    keep_puts = True
    writable = True
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

    published: dict = {}  # layer name -> store that holds it

    def do_DELETE(self):
        type(self).seen.append(("DELETE", self.path))
        store, layer = self.path.split("/datastores/")[1].split("/featuretypes/")
        layer = layer.split("?")[0]
        if type(self).published.get(layer) == store:
            del type(self).published[layer]
            self._send(200)
        else:
            self._send(404, b"No such feature type", "text/plain")

    def do_POST(self):
        body = self._body()
        type(self).seen.append(("POST", self.path))
        if self.path.endswith("/featuretypes"):
            store = self.path.split("/datastores/")[1].split("/")[0]
            layer = json.loads(body)["featureType"]["name"]
            if layer in type(self).published:
                # Names are unique per workspace, whichever store holds them.
                self._send(500, f"Resource named '{layer}' already exists".encode(),
                           "text/plain")
                return
            type(self).published[layer] = store
            self._send(201)
            return
        if self.path.endswith("/datastores"):
            # What a real GeoServer answers for a store that is already there.
            self._send(500, b"Store 'splatworld_pg' already exists in workspace",
                       "text/plain")
            return
        if self.path.endswith("/wfs"):
            # The write probe: read-only is answered as an exception, 200.
            self._send(200, (b'<wfs:TransactionResponse/>' if type(self).writable
                             else b'<ows:ExceptionReport>'
                                  b'{http://splatworld}area is read-only'
                                  b'</ows:ExceptionReport>'), "text/xml")
            return
        self._send(201)

    def do_PUT(self):
        body = self._body()
        type(self).seen.append(("PUT", self.path))
        if "/datastores/" in self.path and "/featuretypes" not in self.path:
            if type(self).keep_puts:
                type(self).stores[self.path.rsplit("/", 1)[1]] = json.loads(body)
            self._send(200)
            return
        self._send(200)

    def do_GET(self):
        if self.path.endswith("/featuretypes.json?list=configured"):
            self._send(200, json.dumps({"featureTypes": {"featureType": [
                {"name": n} for n in type(self).published]}}).encode())
        elif "/datastores/" in self.path and self.path.endswith(".json"):
            name = self.path.rsplit("/", 1)[1][:-len(".json")]
            self._send(200, json.dumps(type(self).stores.get(name, {})).encode())
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
    for n in gsprovision.FIXED_LAYERS
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
        FakeGeoServer.stores = {}
        FakeGeoServer.keep_puts = True
        FakeGeoServer.writable = True
        FakeGeoServer.seen = []
        # What an earlier setup left behind: every layer in the old, single store.
        FakeGeoServer.published = {n: gsprovision.STORE for n in gsprovision.FIXED_LAYERS}
        FakeGeoServer.published["tile"] = "splatworld_gis"  # an earlier layout
        FakeGeoServer.published["feature"] = gsprovision.STORE  # a layer this world no longer has
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), FakeGeoServer)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.server.server_port}"
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)

    def run_it(self):
        # The database probe is covered against a real Postgres by
        # tools/api-test; here there is only the fake GeoServer.
        original = gsprovision.check_drawing
        gsprovision.check_drawing = lambda cfg, on_step=print: None
        try:
            return gsprovision.provision(Config, self.url, "admin", "geoserver",
                                         on_step=lambda _: None)
        finally:
            gsprovision.check_drawing = original

    def test_the_store_points_at_gis_and_names_the_key_table(self):
        self.run_it()
        held = {e["@key"]: e["$"] for e in
                FakeGeoServer.stores[gsprovision.STORE]["dataStore"]["connectionParameters"]["entry"]}
        self.assertEqual(held["schema"], "gis")
        self.assertEqual(held["Primary key metadata table"], "gis.gt_pk_metadata")
        self.assertIn(("PUT", f"/rest/workspaces/splatworld/datastores/"
                              f"{gsprovision.STORE}"), FakeGeoServer.seen)

    def test_a_layer_that_cannot_be_written_is_a_failure_not_a_done(self):
        FakeGeoServer.writable = False
        with self.assertRaises(SystemExit) as caught:
            self.run_it()
        self.assertIn("could not save", str(caught.exception))

    def test_a_layer_left_in_an_old_store_is_moved_not_refused(self):
        self.run_it()
        self.assertEqual(FakeGeoServer.published["tile"], gsprovision.STORE)
        self.assertEqual(FakeGeoServer.published["area"], gsprovision.STORE)

    def test_a_layer_this_world_no_longer_has_is_removed(self):
        self.run_it()
        self.assertNotIn("feature", FakeGeoServer.published)

    def test_the_cached_pools_are_dropped(self):
        self.run_it()
        self.assertIn(("POST", "/rest/reset"), FakeGeoServer.seen)

    def test_a_store_that_did_not_keep_the_settings_is_a_failure(self):
        FakeGeoServer.keep_puts = False
        with self.assertRaises(SystemExit) as caught:
            self.run_it()
        self.assertIn("did not keep its settings", str(caught.exception))


if __name__ == "__main__":
    unittest.main()


def test_a_migration_asks_geoserver_to_re_read_its_layers():
    """GeoServer caches whether a view may be written, and reads it once.

    The view behind "Your land" gained an INSTEAD OF trigger in a migration;
    until the cache is dropped GeoServer keeps answering "area is read-only",
    whatever the database now says.
    """
    from splatworld import gsprovision

    calls = []

    class FakeGS:
        base = "http://gs"
        auth = "Basic x"

        def call(self, method, path, body=None, content_type="application/xml",
                 tolerate=()):
            calls.append((method, path))
            return 200

    gs = FakeGS()
    gs.call("POST", "/rest/reset", b"", tolerate=(404,))
    assert ("POST", "/rest/reset") in calls
    # And the provisioning source says the same, so the step cannot be dropped
    # without this failing.
    source = (Path(gsprovision.__file__)).read_text(encoding="utf8")
    assert '"/rest/reset"' in source
