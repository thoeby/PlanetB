// hudmap.js — the 240 px map in the corner: the land around you, what stands
// on it, and where you are looking (spec §2.3, the small version).
//
// It draws what it is handed and reads nothing: the areas are the same rows the
// Your land panel lists, so the two cannot disagree about who owns what.

const M_PER_DEG = 111320;

export const SPANS = [250, 500, 1000, 2000, 5000, 20000];

// How many metres across the map has to be to hold the land it must draw.
export function spanFor(areas, at, fallback = 500) {
    const boxes = (areas ?? []).map(bbox).filter(Boolean);
    if (!boxes.length) return fallback;
    const cos = Math.cos((at.lat * Math.PI) / 180) || 1;
    const far = Math.max(...boxes.flatMap(([w, s, e, n]) => [
        Math.abs((w - at.lon) * M_PER_DEG * cos), Math.abs((e - at.lon) * M_PER_DEG * cos),
        Math.abs((s - at.lat) * M_PER_DEG), Math.abs((n - at.lat) * M_PER_DEG),
    ]));
    return SPANS.find((v) => v / 2 > far) ?? SPANS.at(-1);
}

// An area arrives either with a bbox or with a ring of lon/lat pairs; both are
// reduced to west, south, east, north.
function bbox(a) {
    if (Array.isArray(a?.bbox) && a.bbox.length === 4) return a.bbox.map(Number);
    const ring = a?.ring ?? a?.coordinates?.[0];
    if (!Array.isArray(ring) || !ring.length) return null;
    const xs = ring.map((p) => Number(p[0]));
    const ys = ring.map((p) => Number(p[1]));
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

export function drawMinimap(canvas, { areas = [], things = [], at, heading = 0 }) {
    const ctx = canvas?.getContext?.('2d');
    if (!ctx || !at) return null;
    const { width: w, height: h } = canvas;
    const span = spanFor(areas, at);
    const scale = w / span;
    const cos = Math.cos((at.lat * Math.PI) / 180) || 1;
    const xy = (lon, lat) => [
        w / 2 + (lon - at.lon) * M_PER_DEG * cos * scale,
        h / 2 - (lat - at.lat) * M_PER_DEG * scale,
    ];

    ctx.clearRect(0, 0, w, h);
    grid(ctx, w, h);
    for (const a of areas) boundary(ctx, a, xy);
    for (const t of things) thing(ctx, xy(Number(t.lon), Number(t.lat)));
    you(ctx, w / 2, h / 2, heading);
    return span;
}

function grid(ctx, w, h) {
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.lineWidth = 1;
    for (let p = 0; p <= Math.max(w, h); p += 30) {
        ctx.beginPath();
        ctx.moveTo(p + 0.5, 0);
        ctx.lineTo(p + 0.5, h);
        ctx.moveTo(0, p + 0.5);
        ctx.lineTo(w, p + 0.5);
        ctx.stroke();
    }
}

// Your land is drawn in the accent; everybody else's in outline only, which is
// the same distinction the legend makes.
function boundary(ctx, area, xy) {
    const box = bbox(area);
    if (!box) return;
    const [x0, y0] = xy(box[0], box[3]);
    const [x1, y1] = xy(box[2], box[1]);
    ctx.fillStyle = area.mine ? 'oklch(0.78 0.14 200 / 0.22)' : 'rgba(255,255,255,0.05)';
    ctx.strokeStyle = area.mine ? 'oklch(0.78 0.14 200)' : 'rgba(255,255,255,0.25)';
    ctx.lineWidth = 1;
    ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
    ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
}

function thing(ctx, [x, y]) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(Math.PI / 4);
    ctx.fillStyle = 'oklch(0.82 0.16 80)';
    ctx.fillRect(-3.5, -3.5, 7, 7);
    ctx.restore();
}

// The cone is what you are looking at; the dot is you.
function you(ctx, x, y, heading) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate((heading * Math.PI) / 180);
    ctx.fillStyle = 'oklch(0.78 0.14 200 / 0.25)';
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(-20, -40);
    ctx.lineTo(20, -40);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
    ctx.fillStyle = '#f2efe8';
    ctx.strokeStyle = '#0b0d10';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x, y, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
}
