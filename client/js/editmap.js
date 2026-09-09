// editmap.js — the OpenLayers half of edit.html: the world's own ortho pyramid
// as a basemap, the vector layers over it, and the arithmetic that turns the
// map's view into something PostgREST can be asked about.
//
// No DOM beyond the map's own target and no policy: editui.js owns the panel
// and edit.js owns what a feature is. OpenLayers arrives as the global `ol`
// (the built bundle in the page's script tag), because a no-bundler client
// cannot resolve the bare specifiers its ES modules import each other by.

export const COLOURS = {
    road: '#d8b84a', forest: '#54a15a', water: '#4a8fc4',
    footprint: '#d0794f', terrainmod: '#9b7fd0',
};
export const AREA_COLOURS = { write: '#5fa96a', propose: '#d8b84a', read: '#6d7780' };

// The world has only the even zooms (the `zoom` domain, db/0001_schema.sql), so
// the grid is built from those and not from the usual XYZ ladder: a z13 request
// would be a permanent 404. It is the world's own imagery — Invariant 10 leaves
// no room for a basemap service, and drawing over what the compiler reads is
// the point anyway.
const ORTHO_ZOOMS = [6, 8, 10, 12, 14];
const R0 = 156543.03392804097;

const rgba = (hex, a) => `rgba(${parseInt(hex.slice(1, 3), 16)},`
    + `${parseInt(hex.slice(3, 5), 16)},${parseInt(hex.slice(5, 7), 16)},${a})`;

export function orthoLayer(ol, filesUrl) {
    const grid = new ol.tilegrid.TileGrid({
        extent: ol.proj.get('EPSG:3857').getExtent(),
        resolutions: ORTHO_ZOOMS.map((z) => R0 / 2 ** z),
        // CSS pixels; the files are 512 (tools/seed-ortho.sh), which is what
        // tilePixelRatio below says. Without it they are drawn at half their
        // resolution.
        tileSize: 256,
    });
    const url = ([i, x, y]) => `${filesUrl}/geo/ortho/${ORTHO_ZOOMS[i]}/${x}/${y}.webp`;
    return new ol.layer.Tile({
        source: new ol.source.XYZ({ tileGrid: grid, tileUrlFunction: url,
            tilePixelRatio: 2 }),
    });
}

function styleFor(ol, kind, on) {
    const colour = COLOURS[kind] ?? '#9aa4ad';
    return new ol.style.Style({
        stroke: new ol.style.Stroke({ color: colour, width: on ? 4 : 2 }),
        fill: new ol.style.Fill({ color: rgba(colour, on ? 0.45 : 0.2) }),
        image: new ol.style.Circle({ radius: 4,
            fill: new ol.style.Fill({ color: colour }) }),
    });
}

function areaStyleFor(ol, may) {
    const colour = AREA_COLOURS[may] ?? AREA_COLOURS.read;
    return new ol.style.Style({
        stroke: new ol.style.Stroke({ color: colour, width: 2, lineDash: [7, 5] }),
        fill: new ol.style.Fill({ color: rgba(colour, 0.05) }),
    });
}

export function buildMap(ol, target, filesUrl) {
    const cache = new Map();
    const style = (f, on) => {
        const key = `${f.get('kind')}:${on}`;
        if (!cache.has(key)) cache.set(key, styleFor(ol, f.get('kind'), on));
        return cache.get(key);
    };
    const areas = new ol.source.Vector();
    const features = new ol.source.Vector();
    const layer = new ol.layer.Vector({ source: features, style: (f) => style(f, false) });
    const map = new ol.Map({
        target,
        layers: [orthoLayer(ol, filesUrl),
            new ol.layer.Vector({ source: areas,
                style: (f) => areaStyleFor(ol, f.get('may')) }),
            layer],
        view: new ol.View({ center: [0, 0], zoom: 2 }),
    });
    return { map, layer, areas, features, style, gj: new ol.format.GeoJSON() };
}

export const PROJ = { dataProjection: 'EPSG:4326', featureProjection: 'EPSG:3857' };

export const geoOf = (ctx, feature) =>
    ctx.gj.writeGeometryObject(feature.getGeometry(), { ...PROJ, decimals: 9 });

export function viewBbox(map, ol) {
    const [west, south, east, north] = ol.proj.transformExtent(
        map.getView().calculateExtent(map.getSize()), 'EPSG:3857', 'EPSG:4326');
    return { west, south, east, north };
}

