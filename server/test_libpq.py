"""postgrest.exe on Windows cannot start without libpq.dll.

Its Windows build links libpq dynamically and ships without it, so starting it
with PostgreSQL's bin directory off PATH kills it before it says anything. The
supervisor puts that directory on the child's PATH. There is no Windows here,
so what is tested is the choosing and the PATH, not the loading.
"""
from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from splatworld import services


class PgBinTest(unittest.TestCase):
    def test_the_one_that_actually_holds_the_library_is_chosen(self):
        with tempfile.TemporaryDirectory() as tmp:
            empty = Path(tmp) / "17" / "bin"
            real = Path(tmp) / "16" / "bin"
            empty.mkdir(parents=True)
            real.mkdir(parents=True)
            (real / "libpq.dll").write_text("")
            self.assertEqual(services.pg_bin([empty, real]), real)

    def test_nothing_is_chosen_when_nothing_has_it(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertIsNone(services.pg_bin([tmp]))


class PathTest(unittest.TestCase):
    def test_off_windows_the_environment_is_left_alone(self):
        with mock.patch.object(services.sys, "platform", "linux"):
            env = {"PATH": "/usr/bin"}
            self.assertEqual(services.with_libpq(env), env)

    def test_on_windows_it_goes_in_front(self):
        with tempfile.TemporaryDirectory() as tmp:
            bin_dir = Path(tmp) / "bin"
            bin_dir.mkdir()
            (bin_dir / "libpq.dll").write_text("")
            with mock.patch.object(services.sys, "platform", "win32"), \
                 mock.patch.object(services, "_candidate_pg_bins",
                                   return_value=[bin_dir]):
                out = services.with_libpq({"PATH": "C:/windows"})
            self.assertEqual(out["PATH"], f"{bin_dir}{os.pathsep}C:/windows")

    def test_a_path_that_already_has_it_is_not_changed(self):
        with tempfile.TemporaryDirectory() as tmp:
            bin_dir = Path(tmp) / "bin"
            bin_dir.mkdir()
            (bin_dir / "libpq.dll").write_text("")
            env = {"PATH": f"C:/windows{os.pathsep}{bin_dir}"}
            with mock.patch.object(services.sys, "platform", "win32"), \
                 mock.patch.object(services, "_candidate_pg_bins",
                                   return_value=[bin_dir]):
                self.assertEqual(services.with_libpq(env), env)


if __name__ == "__main__":
    unittest.main()
