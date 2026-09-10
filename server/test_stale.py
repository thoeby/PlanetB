"""A pulled fix that is not the code running must say so, not pretend.

`git pull` updates the checkout; the `splatworld run` already going keeps
executing what it loaded at start. That looked exactly like the fix not
working, twice, so the server now checks and refuses.
"""
from __future__ import annotations

import sys
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from splatworld import serve  # noqa: E402


class Config:
    repo = Path(__file__).resolve().parents[1]


class VersionTest(unittest.TestCase):
    def test_the_page_and_the_package_agree_on_the_version(self):
        stated = (Path(__file__).resolve().parents[1]
                  / "client" / "version.txt").read_text().strip()
        self.assertEqual(stated, serve.__version__,
                         "client/version.txt is what the setup page compares "
                         "against; if they drift the page cries wolf")


class CopyTest(unittest.TestCase):
    """A copy install that has fallen behind the checkout is the same trap."""

    def test_a_copy_behind_the_checkout_says_so(self):
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            fake_repo = Path(tmp)
            (fake_repo / "server" / "splatworld").mkdir(parents=True)
            newer = fake_repo / "server" / "splatworld" / "serve.py"
            newer.write_text("# newer than anything installed\n")
            import os

            os.utime(newer, (time.time() + 10_000, time.time() + 10_000))

            class Elsewhere:
                repo = fake_repo

            serve.STARTED = time.time()
            message = serve.code_is_stale(Elsewhere)
            self.assertIsNotNone(message)
            self.assertIn("pip install -e ./server", message)


class StaleTest(unittest.TestCase):
    def test_unchanged_code_is_not_stale(self):
        serve.STARTED = time.time()
        self.assertIsNone(serve.code_is_stale(Config))

    def test_a_source_file_newer_than_the_process_is_stale(self):
        serve.STARTED = time.time() - 3600
        message = serve.code_is_stale(Config)
        self.assertIsNotNone(message)
        self.assertIn("splatworld run", message)


if __name__ == "__main__":
    unittest.main()


class PortTest(unittest.TestCase):
    """A second server must not quietly take another port and leave the first
    one answering the browser tab that is already open."""

    def test_a_splatworld_on_the_port_is_recognised(self):
        import threading
        from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

        class Ours(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def do_GET(self):
                body = b"0.2.0\n" if self.path == "/app/version.txt" else b""
                self.send_response(200 if body else 404)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        httpd = ThreadingHTTPServer(("127.0.0.1", 0), Ours)
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        self.addCleanup(httpd.server_close)
        self.addCleanup(httpd.shutdown)
        port = httpd.server_port
        self.assertTrue(serve.already_running("127.0.0.1", port))

    def test_nothing_there_is_not_one_of_ours(self):
        import socket

        s = socket.socket()
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
        s.close()
        self.assertFalse(serve.already_running("127.0.0.1", port))
