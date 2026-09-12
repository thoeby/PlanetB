// land.js — your land, in the world and in the panel (design 3b).
//
// The panel is the artboard: every area you may touch, then the one you chose
// with its counts, how many approvals it needs, who else may work on it, and
// what is waiting for a decision. Every number and every name comes from an
// RPC that already existed — my_areas, area_progress, area_grants,
// my_proposals — so the panel states the world rather than deciding anything.
//
// The outline in the world is drawn rather than modelled — three lines a
// frame, no entity, nothing to dispose — because it is a hint about
// permission, not part of the world. Cyan is yours, amber is somebody's you
// may propose to, grey is everyone else's: the legend's three colours.

import * as api from './api.js';
import { landRows, selected } from './landui.js';

const el = (tag, props = {}, ...kids) => {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...kids.filter((k) => k !== null && k !== undefined));
    return node;
};

// A polygon's rings, as [lon, lat] pairs, whatever GeoJSON shape it arrived in.
export function ringsOf(outline) {
    if (!outline) return [];
    if (outline.type === 'Polygon') return outline.coordinates;
    if (outline.type === 'MultiPolygon') return outline.coordinates.flat();
    return [];
}

// Every area, drawn at the height the ground is under each corner so the line
// follows the hill rather than cutting through it.
export function drawAreas(ctx, areas) {
    const { pc, app, origin, terrain } = ctx;
    for (const area of areas ?? []) {
        const colour = area.mine ? new pc.Color(0.35, 0.85, 0.95)
            : area.may_propose ? new pc.Color(0.95, 0.78, 0.35)
                : new pc.Color(0.55, 0.6, 0.65);
        for (const ring of ringsOf(area.outline)) {
            let last = null;
            for (const [lon, lat] of ring) {
                const p = origin.localOf({ lon, lat, h: 0 });
                const ground = terrain?.heightAt(p);
                const at = new pc.Vec3(p.x, (ground ?? p.y) + 1.5, p.z);
                if (last) app.drawLine(last, at, colour);
                last = at;
            }
        }
    }
}

export const areaName = (a) => a?.rules?.name || 'unnamed land';

// Everything the chosen area's card shows, in one round of requests.
async function cardOf(area) {
    const empty = {
        contents: [], drawn: [], progress: null, grants: [], proposals: [],
    };
    if (!area) return empty;
    const [contents, drawn, progress, grants, proposals] = await Promise.all([
        api.rpc('area_contents', { area_id: area.id }).catch(() => []),
        api.rpc('area_drawn', { area_id: area.id }).catch(() => []),
        api.rpc('area_progress', { area_id: area.id }).catch(() => null),
        api.rpc('area_grants', { area_id: area.id }).catch(() => []),
        api.rpc('my_proposals').catch(() => []),
    ]);
    return {
        contents: contents ?? [],
        drawn: drawn ?? [],
        progress,
        grants: grants ?? [],
        proposals: (proposals ?? []).filter((p) => p.area_id === area.id),
    };
}

async function removing(item, onRemove, say, reload) {
    try {
        await onRemove(item);
        say(`${item.name || item.san} removed`);
        await reload();
    } catch (err) {
        say(String(err.body?.message ?? err.message ?? err), true);
    }
}

export function mountLand(host, { onGo = () => {}, onRemove = () => {} } = {}) {
    const list = el('ul', { className: 'rows land-areas' });
    const detail = el('div', { className: 'land-detail' });
    const status = el('p', { className: 'land-status status' });
    host.append(list, detail, status);

    const state = {
        areas: [], chosen: null, contents: [], drawn: [], progress: null,
        grants: [], proposals: [],
    };

    const say = (msg, bad = false) => {
        status.textContent = msg;
        status.dataset.bad = bad ? '1' : '';
    };

    // One place where the panel is redrawn, so every action ends the same way.
    function draw() {
        list.replaceChildren(...landRows(state, pick));
        const area = state.areas.find((a) => a.id === state.chosen);
        detail.replaceChildren(...selected(area, state, {
            onGo, onRemove: remove, say, refresh: () => load(area), api,
        }));
    }

    async function pick(area) {
        state.chosen = area?.id ?? null;
        draw();
        await load(area);
    }

    async function load(area) {
        Object.assign(state, await cardOf(area));
        draw();
    }

    const remove = (item) => removing(item, onRemove, say,
        () => load(state.areas.find((a) => a.id === state.chosen)));

    async function refresh() {
        state.areas = await api.rpc('my_areas').catch(() => []);
        const chosen = state.areas.find((a) => a.id === state.chosen)
            ?? state.areas.find((a) => a.mine) ?? state.areas[0];
        state.chosen = chosen?.id ?? null;
        draw();
        if (chosen) await load(chosen);
        return state.areas;
    }

    refresh();
    return {
        refresh,
        areas: () => state.areas,
        chosen: () => state.chosen,
        inside: pick,
        // What stands on the chosen land, for the map and for the first of the
        // chrome's five stages.
        things: () => state.contents,
    };
}
