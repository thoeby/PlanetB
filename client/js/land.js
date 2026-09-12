// land.js — your land, in the world and in the panel.
//
// TASKS-usable T5: the ground you own is outlined where it actually is, and the
// panel lists what stands on it. The outline is drawn rather than modelled —
// three lines a frame, no entity, nothing to dispose — because it is a hint
// about permission, not part of the world.
//
// Cyan is yours, amber is somebody's you may propose to, grey is everyone
// else's. The same three colours the legend uses (client/hud.css).

import * as api from './api.js';
import { copyLink, visitLink } from './visit.js';

const HTML = `
<ul class="land-areas"></ul>
<div class="land-inside">
  <label>On this land</label>
  <ul class="land-contents"></ul>
</div>
<p class="land-status status"></p>`;

const el = (tag, props = {}, ...kids) => {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...kids);
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

function areaRow(area, onPick, chosen) {
    const name = area.rules?.name || 'unnamed land';
    const b = el('button', { type: 'button',
        textContent: `${name}${area.mine ? '' : ' · not yours'}` });
    b.onclick = () => onPick(area);
    const li = el('li', { className: 'land-area' }, b);
    li.dataset.on = area.id === chosen ? '1' : '';
    return li;
}

// A link to what is on your land, so somebody else can stand in front of it
// (T8). The position is the thing's own, not the camera's.
const linkTo = (item) => visitLink(globalThis.location.href,
    { lat: item.lat, lon: item.lon, h: item.h ?? 0, heading: 0 });

function contentRow(item, onGo, onDrop, say) {
    const go = el('button', { type: 'button',
        textContent: item.name || item.san || 'something' });
    go.onclick = () => onGo(item);
    const share = el('button', { type: 'button', textContent: 'link' });
    share.onclick = async () => say(await copyLink(document, linkTo(item))
        ? 'link copied — it puts somebody in front of it'
        : linkTo(item));
    const row = el('li', { className: 'land-item' }, go, share);
    if (item.mine) {
        const drop = el('button', { type: 'button', textContent: 'remove' });
        drop.onclick = () => onDrop(item);
        row.append(drop);
    }
    return row;
}

export function mountLand(host, { onGo = () => {}, onRemove = () => {} } = {}) {
    const box = el('div');
    box.innerHTML = HTML;
    host.append(box);
    const q = (sel) => box.querySelector(sel);
    const state = { areas: [], chosen: null, contents: [] };

    const say = (msg, bad = false) => {
        q('.land-status').textContent = msg;
        q('.land-status').dataset.bad = bad ? '1' : '';
    };

    async function inside(area) {
        state.chosen = area?.id ?? null;
        state.contents = area ? await api.rpc('area_contents', { area_id: area.id })
            .catch(() => []) : [];
        q('.land-contents').replaceChildren(...state.contents.map(
            (item) => contentRow(item, onGo, remove, say)));
        if (area && !state.contents.length) {
            q('.land-contents').append(el('li', { className: 'muted',
                textContent: 'nothing on it yet — the Place tab puts something here' }));
        }
        draw();
    }

    async function remove(item) {
        try {
            await onRemove(item);
            say(`${item.name || item.san} removed`);
            await inside(state.areas.find((a) => a.id === state.chosen));
        } catch (err) {
            say(String(err.body?.message ?? err.message ?? err), true);
        }
    }

    function draw() {
        q('.land-areas').replaceChildren(...state.areas.map(
            (a) => areaRow(a, inside, state.chosen)));
        if (!state.areas.length) {
            q('.land-areas').append(el('li', { className: 'muted',
                textContent: 'no land yet — draw an area in QGIS and it appears here' }));
        }
    }

    async function refresh() {
        state.areas = await api.rpc('my_areas').catch(() => []);
        draw();
        const chosen = state.areas.find((a) => a.id === state.chosen)
            ?? state.areas.find((a) => a.mine) ?? state.areas[0];
        if (chosen) await inside(chosen);
        return state.areas;
    }

    refresh();
    return {
        refresh, areas: () => state.areas, chosen: () => state.chosen, inside,
        // What stands on the chosen land, for the map and for the first of the
        // chrome's five stages.
        things: () => state.contents,
    };
}
