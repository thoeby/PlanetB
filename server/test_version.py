"""client/version.txt is what the setup page compares against the server's
version to tell a stale server from a fresh page; the two must not drift."""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from splatworld import serve  # noqa: E402


class VersionTest(unittest.TestCase):
    def test_the_page_and_the_package_agree_on_the_version(self):
        stated = (Path(__file__).resolve().parents[1]
                  / "client" / "version.txt").read_text().strip()
        self.assertEqual(stated, serve.__version__)


if __name__ == "__main__":
    unittest.main()
