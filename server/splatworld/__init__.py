"""Runs a splatworld on one machine.

The same code serves a laptop and a real server: `splatworld run` starts the
file store and the static client, applies the schema, and supervises PostgREST.
It computes nothing about the world — every atom still runs in a browser tab
(Invariant 9).
"""
# Kept equal to client/version.txt, which the setup page reads straight from
# the checkout. The page compares the two: a static file is whatever was last
# pulled, so a server answering with an older version is proof that what is
# running is not what is on disk — the one thing that cannot be detected by
# the running code itself, because the running code is the thing at fault.
__version__ = "0.8.2"


def _use_own_proj_data() -> dict[str, str]:
    """Ignore a PROJ data directory inherited from some other installation.

    rasterio's wheels carry their own GDAL and PROJ, and PROJ reads its
    database from `PROJ_DATA` (`PROJ_LIB` before PROJ 9.1) whenever that is
    set. PostgreSQL's Windows installer sets it machine-wide to the copy
    beside PostGIS, which is a PROJ 6-era `proj.db`; rasterio then reads that
    one instead of its own and every EPSG lookup fails with

        CRSError: The EPSG code is unknown. PROJ: proj_create_from_database:
        ...\\postgis-3.6\\proj\\proj.db contains DATABASE.LAYOUT.VERSION.MINOR
        = 2 whereas a number >= 6 is expected.

    Dropping the variables here — this module is imported before anything
    imports rasterio — makes PROJ fall back to the data it shipped with.
    Only this process is affected: PostGIS keeps its own copy, and the
    machine's environment is not touched.
    """
    import os

    return {var: os.environ.pop(var)
            for var in ("PROJ_DATA", "PROJ_LIB") if os.environ.get(var)}


#: What `_use_own_proj_data()` dropped, so `splatworld doctor` can say so.
IGNORED_PROJ_DATA = _use_own_proj_data()
