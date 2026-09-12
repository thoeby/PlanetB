"""The coordinate systems, in one place.

The database defines them (db/0056_crs.sql: world_srid(), tile_srid(),
tile_bbox_merc()) and this module repeats them for code that runs before or
without a database — provisioning a GeoServer, cutting a tile. test_crs.py
pins the two to each other and refuses an EPSG code spelled anywhere else
under server/splatworld, so there is nothing to keep in sync by hand.
"""
from __future__ import annotations

# What every geometry column stores: longitude, latitude. What QGIS draws in,
# what WFS and PostgREST exchange, what GeoServer is told to declare.
WORLD_SRID = 4326
WORLD = f"EPSG:{WORLD_SRID}"

# What the ZXY tile grid is defined in, and every ground raster is cut in.
TILE_SRID = 3857
TILE = f"EPSG:{TILE_SRID}"

# QGIS's own row id for the world CRS in its srs database; a project file
# names both. It is a QGIS constant, not an EPSG one.
QGIS_SRSID = "3452"
QGIS_WKT = (
    'GEOGCRS["WGS 84",DATUM["World Geodetic System 1984",'
    'ELLIPSOID["WGS 84",6378137,298.257223563]],'
    'PRIMEM["Greenwich",0],CS[ellipsoidal,2],'
    'AXIS["geodetic latitude (Lat)",north],AXIS["geodetic longitude (Lon)",east],'
    f'ANGLEUNIT["degree",0.0174532925199433],ID["EPSG",{WORLD_SRID}]]'
)
QGIS_PROJ4 = "+proj=longlat +datum=WGS84 +no_defs"
QGIS_ELLIPSOID = "EPSG:7030"  # WGS 84, the world CRS's ellipsoid

# Half the side of the Web-Mercator square, in metres.
MERC_R = 20037508.342789244


def tile_bounds(z: int, x: int, y: int) -> tuple[float, float, float, float]:
    """(west, south, east, north) of a tile in the tile projection.

    The same arithmetic as tile_bbox_merc() in the database, so a tile cut here
    is the tile the database means.
    """
    span = 2 * MERC_R / (2 ** z)
    return (-MERC_R + x * span, MERC_R - (y + 1) * span,
            -MERC_R + (x + 1) * span, MERC_R - y * span)
