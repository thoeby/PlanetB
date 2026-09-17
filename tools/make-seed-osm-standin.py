#!/usr/bin/env python3
"""The stand-in for tools/make-seed-osm.sh, where Overpass cannot be reached.

Not real OSM: shapes written here by hand, in OSM's own keys and values, over
the same 4 x 4 km of Visp the DEM covers. It exists so the stories that load
OSM data through QGIS can run on a machine whose egress policy denies
Overpass, Geofabrik and swisstopo alike. It is deterministic: the same file
every time, so a hash test over anything compiled from it stays a hash test.

    python3 tools/make-seed-osm-standin.py out.geojson
"""
import json
import math
import sys

# Visp church tower, and the extent tools/make-seed-dem.sh cuts around it.
LAT0, LON0 = 46.2939, 7.8815
M_LAT = 1.0 / 111320.0
M_LON = 1.0 / (111320.0 * math.cos(math.radians(LAT0)))


def p(east_m, north_m):
    """A point given in metres east and north of the church tower."""
    return [round(LON0 + east_m * M_LON, 7), round(LAT0 + north_m * M_LAT, 7)]


def line(pts):
    return {'type': 'LineString', 'coordinates': [p(*q) for q in pts]}


def box(east_m, north_m, w, h):
    """An axis-aligned ring, closed, counter-clockwise."""
    e, n, w2, h2 = east_m, north_m, w / 2, h / 2
    ring = [p(e - w2, n - h2), p(e + w2, n - h2), p(e + w2, n + h2),
            p(e - w2, n + h2), p(e - w2, n - h2)]
    return {'type': 'Polygon', 'coordinates': [ring]}


LINES = [
    # The road every symbol story is about: secondary, lit, two lanes.
    ({'highway': 'secondary', 'name': 'Kantonsstrasse', 'lit': 'yes',
      'surface': 'asphalt', 'lanes': 2, 'width': 6.0},
     line([(-900, -120), (-400, -40), (0, 40), (420, 60), (900, 20)])),
    # Long enough to cross whatever boundary an admin draws: the refusal for a
    # feature that leaves your land has to be reachable (story 19).
    ({'highway': 'unclassified', 'name': 'Talstrasse', 'surface': 'asphalt'},
     line([(-1800, 900), (-600, 700), (600, 640), (1800, 780)])),
    ({'highway': 'residential', 'name': 'Dorfstrasse', 'surface': 'asphalt'},
     line([(60, 40), (120, 260), (90, 520)])),
    ({'highway': 'track', 'surface': 'gravel'},
     line([(-420, -40), (-500, 300), (-380, 640)])),
    # A value the seeded choices do not have, so that the refusal that names
    # the allowed values has something to refuse (story 19, step 4).
    ({'highway': 'bridleway', 'surface': 'ground'},
     line([(420, 60), (700, 300), (760, 700)])),
    ({'railway': 'rail', 'electrified': 'contact_line', 'gauge': 1435},
     line([(-1000, -400), (0, -320), (1000, -360)])),
    ({'waterway': 'stream', 'name': 'Chelchbach', 'width': 2.0},
     line([(-200, 1200), (-140, 600), (-60, 100), (40, -600)])),
    ({'barrier': 'wall', 'height': 1.2, 'material': 'stone'},
     line([(140, 120), (300, 140), (300, 260)])),
    ({'barrier': 'hedge', 'height': 1.8},
     line([(-140, 200), (-40, 210)])),
]

AREAS = [
    ({'building': 'house', 'building:levels': 2, 'roof:shape': 'gabled',
      'height': 7.5}, box(150, 200, 12, 9)),
    ({'building': 'barn', 'building:levels': 1, 'roof:shape': 'gabled'},
     box(190, 260, 18, 10)),
    ({'building': 'chalet', 'building:levels': 2}, box(-260, 420, 11, 8)),
    ({'landuse': 'forest', 'leaf_type': 'needleleaved',
      'leaf_cycle': 'evergreen'}, box(-700, 500, 600, 420)),
    ({'landuse': 'meadow'}, box(300, 500, 400, 300)),
    ({'natural': 'water', 'name': 'Weiher'}, box(500, -200, 120, 90)),
    ({'natural': 'bare_rock'}, box(-900, 1200, 700, 500)),
]

POINTS = [
    ({'natural': 'tree', 'genus': 'Larix', 'species': 'Larix decidua',
      'leaf_type': 'needleleaved', 'height': 18.0}, p(60, 320)),
    ({'natural': 'tree', 'genus': 'Picea', 'leaf_type': 'needleleaved',
      'height': 22.0}, p(-120, 380)),
    ({'natural': 'tree', 'genus': 'Fagus', 'leaf_type': 'broadleaved',
      'height': 14.0}, p(220, 420)),
    ({'natural': 'tree', 'leaf_type': 'broadleaved'}, p(-40, -180)),
    ({'natural': 'tree'}, p(380, -60)),
]


def features():
    for layer, rows in (('lines', LINES), ('areas', AREAS), ('points', POINTS)):
        for tags, geom in rows:
            if layer == 'points':
                geom = {'type': 'Point', 'coordinates': geom}
            yield {'type': 'Feature', 'properties': dict(layer=layer, **tags),
                   'geometry': geom}


def main(path):
    fc = {'type': 'FeatureCollection', 'name': 'standin',
          'features': list(features())}
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(fc, f, indent=1, sort_keys=True)
        f.write('\n')
    print(f'make-seed-osm-standin: {len(fc["features"])} features → {path}')


if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else 'standin.geojson')
