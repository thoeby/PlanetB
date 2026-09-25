// areasmap.js — the map Areas are drawn on, in Survey (EDT.19,
// PLAN-editors.md §2.4).
//
// The world's hillshade from the operator's GeoServer (WMS, the same the
// QGIS project shows), the lands with the player's own lit and everybody
// else's dimmed, the lines read-only in their kinds' colours — they are drawn
// in Build → Lines — and the areas of the chosen land, filled in their
// swatch with their kind written on them. OpenLayers draws it
// (client/js/olboot.js); nothing here writes.

import { TILE, WORLD } from '../lib/crs.js';
import { SWATCH } from '../lib/kinds.js';

export const PROJ = { dataProjection: WORLD, featureProjection: TILE };

const rgba = (hex, a) => {
    const n = parseInt(String(hex).slice(1), 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
};

function hillshade(ol, ground) {
    if (!ground?.geoserver_url || !ground?.coverage) return null;
    return new ol.layer.Image({
        source: new ol.source.ImageWMS({
            url: `${ground.geoserver_url.replace(/\/$/, '')}/wms`,
            params: { LAYERS: ground.coverage, VERSION: '1.3.0' },
            ratio: 1,
        }),
        opacity: 0.9,
    });
}

const landStyle = (ol) => (f) => new ol.style.Style({
    stroke: new ol.style.Stroke({ color: f.get('mine') ? '#5fa96a' : 'rgba(160,170,180,0.6)',
        width: f.get('mine') ? 2.5 : 1.5, lineDash: f.get('mine') ? undefined : [6, 5] }),
    fill: new ol.style.Fill({
        color: f.get('mine') ? 'rgba(95,169,106,0.06)' : 'rgba(10,12,15,0.35)' }),
});

const lineStyle = (ol) => (f) => new ol.style.Style({
    stroke: new ol.style.Stroke({ color: SWATCH[f.get('kind')] ?? '#9aa4ad',
        width: Math.max(2, Math.min(8, Number(f.get('props')?.width) || 3)) }),
});

// An area: its swatch, and its kind and class written in the middle.
const areaStyle = (ol) => (f, res) => {
    const kind = f.get('kind');
    const cls = f.get('props')?.[kind];
    const lit = f.get('selected');
    return new ol.style.Style({
        stroke: new ol.style.Stroke({ color: SWATCH[kind] ?? '#9aa4ad', width: lit ? 3 : 1.5 }),
        fill: new ol.style.Fill({ color: rgba(SWATCH[kind] ?? '#9aa4ad', lit ? 0.55 : 0.4) }),
        text: res < 4 ? new ol.style.Text({ text: [kind, cls].filter(Boolean).join(' · '),
            fill: new ol.style.Fill({ color: '#fff' }), font: '12px Sora, sans-serif',
            stroke: new ol.style.Stroke({ color: 'rgba(0,0,0,0.6)', width: 3 }) }) : undefined,
    });
};

export function buildAreasMap(ol, target, ground) {
    const sources = { lands: new ol.source.Vector(), lines: new ol.source.Vector(),
        areas: new ol.source.Vector(), sketch: new ol.source.Vector() };
    const layers = [
        hillshade(ol, ground),
        new ol.layer.Vector({ source: sources.lands, style: landStyle(ol) }),
        new ol.layer.Vector({ source: sources.areas, style: areaStyle(ol) }),
        new ol.layer.Vector({ source: sources.lines, style: lineStyle(ol) }),
        new ol.layer.Vector({ source: sources.sketch }),
    ].filter(Boolean);
    const map = new ol.Map({ target, layers,
        view: new ol.View({ center: [0, 0], zoom: 2, maxZoom: 22 }) });
    return { ol, map, sources, gj: new ol.format.GeoJSON() };
}

// Rows into a source: GeoJSON geometries in degrees, with what they say.
export function fill(m, source, rows) {
    m.sources[source].clear();
    m.sources[source].addFeatures(rows.filter((r) => r.geom).map((r) => {
        const f = m.gj.readFeature({ type: 'Feature', geometry: r.geom,
            properties: { ...r, geom: undefined } }, PROJ);
        f.setId(r.id ?? r.key);
        return f;
    }));
}

// Frames a land: its box, with some room round it.
export function frame(m, bbox) {
    const ext = m.ol.proj.transformExtent([bbox.west, bbox.south, bbox.east, bbox.north],
        WORLD, TILE);
    m.map.getView().fit(ext, { padding: [40, 40, 40, 40] });
}

export const geoOf = (m, feature) =>
    m.gj.writeGeometryObject(feature.getGeometry(), { ...PROJ, decimals: 9 });
