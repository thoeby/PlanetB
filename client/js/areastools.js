// areastools.js — drawing areas on the Survey map (EDT.20, PLAN-editors.md
// ideas 28 and 29): Draw clicks corners (Shift-drag sketches) and closes on
// the first; Paint is a round brush whose strokes become one area, the way a
// zone is painted in a builder game. Whatever is drawn is clipped to the land
// when it is finished — never refused for crossing the boundary.

import { intersection, paintedOf, pullInside, areaOf as polyArea } from '../lib/polyops.js';
import { landPolys } from './areasmodel.js';
import { PROJ } from './areasmap.js';

export const AREA_TOOLS = [
    { id: 'pan', words: 'Hand', key: 'h' },
    { id: 'draw', words: 'Draw', key: 'd' },
    { id: 'paint', words: 'Paint', key: 'b' },
    { id: 'edit', words: 'Edit', key: 'v' },
    { id: 'erase', words: 'Erase', key: 'e' },
];

/**
 * An area finished: clipped to the land and handed to `made(polys, clipped)`,
 * or refused where none of it is on the land. `polys` are in the model's frame.
 */
export function finish(state, polys, { made, say }) {
    const land = landPolys(state.areas.f, state.land);
    const kept = pullInside(intersection(polys, land), land);
    if (!kept.length) { say('none of that is on your land', true); return null; }
    const clipped = polyArea(kept) < polyArea(polys) - 1;
    return made(kept, clipped);
}

// Draw: OpenLayers' own polygon tool on the sketch layer.
export function drawInteraction(m, state, acts) {
    const { ol } = m;
    const draw = new ol.interaction.Draw({ source: m.sources.sketch, type: 'Polygon' });
    draw.on('drawend', (e) => {
        const g = m.gj.writeGeometryObject(e.feature.getGeometry(), PROJ);
        const polys = [g.coordinates.map((r) => r.slice(0, -1)
            .map(([lon, lat]) => state.areas.f.toXZ(lon, lat)))];
        setTimeout(() => m.sources.sketch.clear());
        finish(state, polys, acts);
    });
    return draw;
}

// Paint: circles along the drag, previewed as they go, one area on release.
export function paintHandlers(m, state, acts) {
    const { ol } = m;
    const viewport = m.map.getViewport();
    let stroke = null;
    const at = (e) => {
        const c = m.map.getEventCoordinate(e);
        const [lon, lat] = ol.proj.toLonLat(c);
        return { c, xz: state.areas.f.toXZ(lon, lat), lat };
    };
    const dab = (e) => {
        const p = at(e);
        const r = state.brush / 2;
        const last = stroke.centres.at(-1);
        if (last && Math.hypot(p.xz[0] - last[0], p.xz[1] - last[1]) < r / 4) return;
        stroke.centres.push(p.xz);
        // A metre on the ground is 1/cos(lat) of the map's own metres.
        m.sources.sketch.addFeature(new ol.Feature(new ol.geom.Circle(p.c,
            r / Math.cos(p.lat * Math.PI / 180))));
    };
    const handlers = {
        pointerdown: (e) => {
            if (state.tool !== 'paint' || e.button !== 0) return;
            stroke = { centres: [] };
            dab(e);
        },
        pointermove: (e) => { if (stroke) dab(e); },
        pointerup: () => {
            if (!stroke) return;
            const centres = stroke.centres;
            stroke = null;
            m.sources.sketch.clear();
            finish(state, paintedOf(centres, state.brush / 2), acts);
        },
    };
    for (const [name, fn] of Object.entries(handlers)) viewport.addEventListener(name, fn);
    return handlers;
}

// Which of OpenLayers' own interactions run for the tool in hand: the map is
// dragged with the hand and while drawing, never while painting.
export function toolsFor(m, state, own) {
    m.map.getInteractions().forEach((i) => {
        if (i instanceof m.ol.interaction.DragPan) i.setActive(state.tool !== 'paint');
    });
    own.draw.setActive(state.tool === 'draw');
    if (state.tool !== 'draw') own.draw.abortDrawing();
    for (const i of own.edit ?? []) i.setActive(state.tool === 'edit');
}
