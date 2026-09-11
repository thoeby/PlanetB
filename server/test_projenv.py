"""A PROJ data directory from another installation must not be inherited.

PostgreSQL's Windows installer sets PROJ_LIB machine-wide to PostGIS's copy,
which is older than the one rasterio's wheels carry. Every EPSG lookup then
fails with "DATABASE.LAYOUT.VERSION.MINOR = 2 whereas a number >= 6 is
expected", which reads like a broken install and is a stale environment.
"""
from __future__ import annotations

import os
import subprocess
import sys
import unittest
from pathlib import Path

SERVER = Path(__file__).resolve().parent
PROBE = ("import os, splatworld;"
         " print(splatworld.IGNORED_PROJ_DATA.get('PROJ_LIB'));"
         " print(os.environ.get('PROJ_LIB'));"
         " print(os.environ.get('PROJ_DATA'))")


def probe(**extra: str) -> list[str]:
    env = {**os.environ, "PYTHONPATH": str(SERVER), **extra}
    out = subprocess.run([sys.executable, "-c", PROBE], env=env,
                         capture_output=True, text=True, check=True)
    return out.stdout.split("\n")


class ProjEnvTest(unittest.TestCase):
    def test_a_foreign_proj_dir_is_dropped_and_remembered(self):
        stale = r"C:\Program Files\PostgreSQL\18\share\contrib\postgis-3.6\proj"
        reported, proj_lib, proj_data = probe(PROJ_LIB=stale, PROJ_DATA=stale)[:3]
        self.assertEqual(reported, stale, "doctor has to be able to say why")
        self.assertEqual(proj_lib, "None", "rasterio would read the stale proj.db")
        self.assertEqual(proj_data, "None", "PROJ 9.1+ reads this one instead")

    def test_an_environment_without_one_is_left_alone(self):
        env = {k: v for k, v in os.environ.items()
               if k not in ("PROJ_LIB", "PROJ_DATA")}
        env["PYTHONPATH"] = str(SERVER)
        out = subprocess.run([sys.executable, "-c", PROBE], env=env,
                             capture_output=True, text=True, check=True)
        self.assertEqual(out.stdout.split("\n")[0], "None")


if __name__ == "__main__":
    unittest.main()
