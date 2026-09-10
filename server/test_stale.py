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
