// areasedit.js — Edit and Erase in Survey → Areas (EDT.22, PLAN-editors.md
// §2.4): a click takes an area in hand, its corners drag (OpenLayers' Modify,
// snapping to the other areas and to the land's own edge), and Erase takes it
// away. Every change is one step of undo, and nothing reaches the world until
// Save (client/js/areasave.js).

import { intersection, pullInside, areaOf as polyArea } from '../lib/polyops.js';
import { landPolys, polysOf } from './areasmodel.js';
import { PROJ } from './areasmap.js';

// The area under a pixel, or null.
export function areaAt(state, pixel) {
    let key = null;
    state.m.map.forEachFeatureAtPixel(pixel, (f, layer) => {
        if (layer?.getSource() === state.m.sources.areas) key = f.getId();
        return Boolean(key);
    }, { hitTolerance: 3 });
    return state.areas?.live.find((a) => a.key === key) ?? null;
}

/**
 * Modify on the area in hand and Snap to every area and to the lands, for
 * the Edit tool (client/js/areastools.js toolsFor turns them on and off).
 */
export function editInteractions(m, state, acts) {
    const { ol } = m;
    const held = new ol.Collection();
    const modify = new ol.interaction.Modify({ features: held });
    modify.on('modifystart', () => state.areas.remember());
    modify.on('modifyend', (e) => {
        const f = e.features.item(0);
        const area = state.areas.live.find((a) => a.key === f?.getId());
        if (area) reshape(state, area, f, acts);
    });
    const snaps = [m.sources.areas, m.sources.lands].map((source) =>
        new ol.interaction.Snap({ source, pixelTolerance: 8 }));
    // What is in hand is the feature drawn for the selected area this time
    // round: the source is filled afresh on every redraw.
    state.hold = () => {
        held.clear();
        const f = state.selected && m.sources.areas.getFeatureById(state.selected.key);
        if (f && state.tool === 'edit') held.push(f);
    };
    return [modify, ...snaps];
}

// A dragged corner: the new outline, clipped to the land again.
function reshape(state, area, f, acts) {
    const raw = polysOf(state.areas.f, m2geo(state.m, f));
    const land = landPolys(state.areas.f, state.land);
    const clipped = pullInside(intersection(raw, land), land);
    // Nothing clipped off: the outline exactly as it was dragged, rather than
    // as the raster traced it back.
    const kept = clipped.length && polyArea(clipped) >= polyArea(raw) - 1 ? raw : clipped;
    if (!kept.length) {
        state.areas.undo();
        acts.say('that would take it off your land', true);
    } else {
        area.polys = kept;
        state.areas.changed(area);
        acts.say(`${words(area)} changed — Save to keep it`);
    }
    acts.redraw();
}

const m2geo = (m, f) => m.gj.writeGeometryObject(f.getGeometry(), { ...PROJ, decimals: 9 });

const words = (a) => a.props?.[a.kind] ?? a.kind;

// A click with Edit takes an area in hand; with Erase, takes it away.
export function areaClick(state, pixel, acts) {
    if (state.tool !== 'edit' && state.tool !== 'erase') return false;
    const area = areaAt(state, pixel);
    if (state.tool === 'erase') {
        if (!area) return false;
        erase(state, area, acts);
        return true;
    }
    state.selected = area;
    acts.redraw();
    if (area) acts.say(`${words(area)} in hand — drag a corner; Delete erases it`);
    return Boolean(area);
}

export function erase(state, area, acts) {
    state.areas.remove(area);
    if (state.selected === area) state.selected = null;
    acts.redraw();
    acts.say(`${words(area)} erased — Save to keep it`);
}

// Undo and redo: the model steps back, and the area in hand is found again by
// its key, since a step is a fresh copy of every area.
export function stepBack(state, acts, forward = false) {
    const key = state.selected?.key;
    const done = forward ? state.areas?.redo() : state.areas?.undo();
    state.selected = state.areas?.live.find((a) => a.key === key) ?? null;
    acts.redraw();
    acts.say(done ? (forward ? 'redone' : 'undone') : `nothing to ${forward ? 'redo' : 'undo'}`);
    return done;
}
