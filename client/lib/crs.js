// The coordinate systems, in one place. The database defines them
// (db/0056_crs.sql) and the browser, which never sees the database's
// definition, repeats them here; client/test/crs.test.js refuses an EPSG code
// spelled anywhere else under client/js and client/lib.

// What every geometry column stores and PostgREST exchanges: lon, lat.
export const WORLD_SRID = 4326;
export const WORLD = `EPSG:${WORLD_SRID}`;

// What the ZXY tile grid is defined in: the map's own projection.
export const TILE = 'EPSG:3857';
