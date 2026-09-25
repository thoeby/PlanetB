// playticks.js — what the page redraws or asks again on a timer rather than
// every frame (play.js).

import * as tm from '../lib/tilemath.js';
import { whatIsMissing } from './hud.js';
import { drawMinimap } from './hudmap.js';
import { ringsOf } from './land.js';
import { EVERY_MS, NEAR_M } from './live.js';
import { EVERY_MS as MOVERS_MS, REACH_M } from './movers.js';
import { mountNextStep } from './nextstep.js';

const every = (ms, fn) => { setInterval(fn, ms); fn(); };

const whereNow = (ctx) => {
    const p = ctx.camera.getPosition();
    return ctx.origin.geodeticOf({ x: p.x, y: p.y, z: p.z });
};

export function startTicks(ctx) {
    // What is missing, and what to do about it. The sentence is for a world
    // that is not set up yet — no ground, no land — because until then there
    // is no route to be on. Once there is land, the card (design 3a) says
    // which of the four steps that land is on and opens the panel that does
    // the next one.
    const nextStep = mountNextStep(ctx.doc.getElementById('hud'), {
        open: (name) => ctx.hud.show(name),
    });
    every(5000, () => sayWhatIsMissing(ctx, nextStep));
    // The map in the corner, on a slow tick: it is a canvas, and nothing on it
    // changes between frames.
    ctx.drawTheMap = () => drawTheMap(ctx);
    every(1000, ctx.drawTheMap);
    every(8000, () => showWhatIsAround(ctx));
    every(EVERY_MS, () => whatIsLive(ctx));
    every(MOVERS_MS, () => whatIsMoving(ctx));
}

// SPEC §3.12: the elevation service stopping is said where the player is, over
// everything else — it is the ground under them — and the page goes on drawing
// what it already has. What went wrong, in the words the server used, and that
// the page has not given up: floor.js asks again every ten seconds and the
// line clears itself the moment a tile arrives.
function trouble(floor) {
    return floor?.trouble
        ? `The elevation service is not answering — ${floor.trouble}`
            + '\nTrying again every few seconds.'
        : '';
}

function sayWhatIsMissing(ctx, nextStep) {
    const { s, ground, hud } = ctx;
    const areas = ctx.land.areas() ?? [];
    const published = [...ctx.streamer.tiles.values()]
        .filter((t) => t.published_version > 0).length;
    const missing = whatIsMissing({
        coverage: ground?.coverage,
        areas: areas.length,
        mine: areas.filter((a) => a.mine).length,
        things: s.onMyLand,
        published,
    });
    // Both would be shouting the same thing at once.
    const onTheRoute = areas.some((a) => a.mine) && ground?.coverage;
    if (Date.now() < s.arrival.until) hud.notice(s.arrival.text);
    else hud.notice(trouble(ctx.floor) || (onTheRoute ? '' : missing));
    const mine = areas.find((a) => a.mine) ?? areas[0];
    nextStep.show({
        things: (ctx.land.things?.() ?? []).length,
        changed: Math.max(0, (s.lastCount?.waiting ?? 0) - (s.lastCount?.open_jobs ?? 0)),
        open: s.lastCount?.open_jobs ?? 0,
        waiting: s.lastWaiting,
        published,
    }, onTheRoute ? (mine?.rules?.name || 'your land') : null);
}

// The tile this tab is computing, as a box on the map: where the minutes of GPU
// are being spent, on the ground they are being spent on. Build is the view the
// world is made in; the others are not about this.
function workingTile(ctx) {
    const t = ctx.hud.app() === 'Build' ? ctx.work.tile() : null;
    if (!t) return null;
    return { ...tm.tileBbox(t.z, t.x, t.y), word: `${t.z}/${t.x}/${t.y}` };
}

// Your land is drawn from the same outlines the Your land panel lists, so the
// two cannot disagree.
function drawTheMap(ctx) {
    const span = drawMinimap(ctx.hud.minimap(), {
        areas: (ctx.land.areas() ?? []).map((a) => ({
            mine: a.mine, ring: ringsOf(a.outline)[0] ?? null,
        })),
        things: ctx.land.things?.() ?? [],
        at: whereNow(ctx),
        heading: ctx.player.heading,
        // The same ground the player is standing on, so the map and the window
        // agree about which way the hill goes. The floor itself, not a wrapper
        // around its z14 answer: a map twenty kilometres across needs the level
        // that can cover it, and heightNear is that (client/js/floor.js).
        ground: ctx.floor,
        // Where this machine is working, while it is working there, and only in
        // the view that is about building the world (SPEC §3.7).
        working: workingTile(ctx),
    });
    if (span) ctx.hud.mapScale(`Map · ${span} m · M`);
}

// SPEC §0.3: a saved object is everybody's to see, whether or not they are
// building. Build mode syncs the preview itself (it has the unsaved ones too);
// this is for everybody else, standing there watching somebody else's land
// change.
async function showWhatIsAround(ctx) {
    if (ctx.build.state.on) return;
    const g = whereNow(ctx);
    await ctx.preview.sync(await ctx.nearby(g.lon, g.lat)).catch(() => {});
}

// FND.15: what changed since the number this tab last saw, for things within
// sight of it. Nothing is asked while nobody is looking at the tab — the lamp
// will still be lit when they come back.
async function whatIsLive(ctx) {
    if (document.hidden) return;
    const g = whereNow(ctx);
    await ctx.liveWorld.poll(g.lon, g.lat, NEAR_M).catch(() => 0);
    // Applied either way: a thing that came into view since the last sweep has
    // to be put in the state the world already said it was in.
    ctx.liveDraw.apply(ctx.liveWorld);
}

async function whatIsMoving(ctx) {
    if (document.hidden) return;
    if (!ctx.movers.checked) await ctx.movers.sync();
    const g = whereNow(ctx);
    await ctx.movers.near(g.lon, g.lat, REACH_M).catch(() => 0);
}
