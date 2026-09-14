// landmap.js — the admin's map of the world's ground: what it draws, where a
// click lands on it, and how it is moved about.
//
// Arithmetic and a canvas, no requests and no decisions. client/js/assignland.js
// is the panel around it — who is waiting, the boundary being drawn, and what
// happens to the land that is picked.
//
// Split out of assignland.js when the map grew a view of its own: it was the
// whole coverage and nothing else, so a four-kilometre world was forty pixels
// of anything anybody wanted to look at.

import { shadeRect } from '../lib/demshade.js';

export const MAP = { w: 420, h: 300, pad: 12 };

// How far in one press of + or − goes, and how far in the map may be taken:
// forty metres across is a garden wall, and past that the DEM behind it has
// nothing more to say.
const STEP = 1.8;
const MIN_SPAN_DEG = 0.0004;

export const boxOf = () => ({
    x: MAP.pad, y: MAP.pad, w: MAP.w - 2 * MAP.pad, h: MAP.h - 2 * MAP.pad,
});

// The rectangle the map is looking at, as lon/lat. `fit` is the whole of the
// world's ground, which is where it starts and what Fit puts it back to.
export function fitView(ground) {
    return {
        west: ground?.west ?? -180, south: ground?.south ?? -85,
        east: ground?.east ?? 180, north: ground?.north ?? 85,
    };
}

export function projection(view) {
    const b = boxOf();
    const dx = (view.east - view.west) || 1;
    const dy = (view.north - view.south) || 1;
    return {
        toPx: (lon, lat) => [b.x + ((lon - view.west) / dx) * b.w,
            b.y + ((view.north - lat) / dy) * b.h],
        toLonLat: (x, y) => [view.west + ((x - b.x) / b.w) * dx,
            view.north - ((y - b.y) / b.h) * dy],
    };
}

// In or out about a point — the cursor where there is one, the middle
// otherwise — and never wider than the ground it is a map of.
export function zoomed(view, factor, fit, about = null) {
    const cx = about?.lon ?? (view.west + view.east) / 2;
    const cy = about?.lat ?? (view.south + view.north) / 2;
    const wide = Math.max((view.east - view.west) / factor, MIN_SPAN_DEG);
    const tall = Math.max((view.north - view.south) / factor, MIN_SPAN_DEG);
    const full = { east: fit.east - fit.west, north: fit.north - fit.south };
    const w = Math.min(wide, full.east);
    const h = Math.min(tall, full.north);
    // Zooming about a point keeps that point where it was on screen, so the
    // thing under the cursor does not slide out from under it.
    const fx = (cx - view.west) / ((view.east - view.west) || 1);
    const fy = (cy - view.south) / ((view.north - view.south) || 1);
    return clamped({ west: cx - w * fx, east: cx + w * (1 - fx),
        south: cy - h * fy, north: cy + h * (1 - fy) }, fit);
}

export function panned(view, dlon, dlat, fit) {
    return clamped({ west: view.west + dlon, east: view.east + dlon,
        south: view.south + dlat, north: view.north + dlat }, fit);
}

// Inside the world, always: a map of ground that has slid off the edge of the
// ground is a map of nothing.
function clamped(view, fit) {
    const w = view.east - view.west;
    const h = view.north - view.south;
    const west = Math.min(Math.max(view.west, fit.west), fit.east - w);
    const south = Math.min(Math.max(view.south, fit.south), fit.north - h);
    return { west, south, east: west + w, north: south + h };
}

// ------------------------------------------------------------------ picking

const ringsOf = (area) => (area?.outline?.type === 'MultiPolygon'
    ? area.outline.coordinates.flat() : (area?.outline?.coordinates ?? []));

// Even-odd, on the rings as they are drawn. An area's outline is already
// simplified to a tenth of a metre (db/0042 area_view), which is finer than a
// pixel of this map at any zoom it offers.
export function pointInArea(area, lon, lat) {
    let inside = false;
    for (const ring of ringsOf(area)) {
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            const [xi, yi] = ring[i];
            const [xj, yj] = ring[j];
            if ((yi > lat) !== (yj > lat)
                && lon < ((xj - xi) * (lat - yi)) / ((yj - yi) || 1e-12) + xi) {
                inside = !inside;
            }
        }
    }
    return inside;
}

// The land under a point, smallest first: a small plot inside a big one is the
// one somebody means when they click on it.
export function areaAt(areas, lon, lat) {
    const hits = (areas ?? []).filter((a) => pointInArea(a, lon, lat));
    if (!hits.length) return null;
    return hits.sort((a, b) => spanOf(a) - spanOf(b))[0];
}

const spanOf = (a) => {
    const b = a.bbox;
    if (!b) return Number.MAX_SAFE_INTEGER;
    return (Number(b.east) - Number(b.west)) * (Number(b.north) - Number(b.south));
};

// ----------------------------------------------------------------- painting

export function paintMap(canvas, { view, ground, areas, corners, shade, picked }) {
    const ctx = canvas?.getContext?.('2d');
    if (!ctx) return;
    const p = projection(view);
    const b = boxOf();
    ctx.clearRect(0, 0, MAP.w, MAP.h);
    ctx.fillStyle = '#11151a';
    ctx.fillRect(0, 0, MAP.w, MAP.h);
    // The land itself, behind everything else. Without it this was outlines
    // floating in a dark box: nothing said which way the valley ran, so a
    // boundary could only be drawn against other boundaries.
    shadeRect(ctx, shade, { ...view, x0: b.x, y0: b.y, w: b.w, h: b.h });
    edge(ctx, p, ground);
    for (const area of areas ?? []) outline(ctx, area, p, area.id === picked);
    drawn(ctx, p, corners ?? []);
}

// The edge of the world, because land outside it cannot be made. Drawn where
// it really is, so zooming in past it shows it going by.
function edge(ctx, p, ground) {
    if (!ground) return;
    const [x0, y0] = p.toPx(ground.west, ground.north);
    const [x1, y1] = p.toPx(ground.east, ground.south);
    ctx.strokeStyle = '#3b444d';
    ctx.setLineDash([5, 4]);
    ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
    ctx.setLineDash([]);
}

function outline(ctx, area, p, on) {
    ctx.strokeStyle = on ? '#e8b45f' : '#cdd5dd';
    ctx.fillStyle = on ? 'rgba(232, 180, 95, 0.22)' : 'rgba(205, 213, 221, 0.08)';
    ctx.lineWidth = on ? 2 : 1;
    for (const ring of ringsOf(area)) {
        ctx.beginPath();
        ring.forEach(([lon, lat], i) => {
            const [x, y] = p.toPx(lon, lat);
            if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
        });
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
    }
    ctx.lineWidth = 1;
}

function drawn(ctx, p, corners) {
    if (!corners.length) return;
    ctx.strokeStyle = '#5fd8e8';
    ctx.fillStyle = '#5fd8e8';
    ctx.beginPath();
    corners.forEach(([lon, lat], i) => {
        const [x, y] = p.toPx(lon, lat);
        if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
        ctx.fillRect(x - 2, y - 2, 4, 4);
    });
    if (corners.length > 2) ctx.closePath();
    ctx.stroke();
}

export { STEP as ZOOM_STEP };
