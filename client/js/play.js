// play.js — the page: the chrome, the world and every panel, mounted in the
// order they depend on each other. Everything shares one `ctx`, so a panel
// mounted early can reach one mounted later by the time anybody presses
// anything; mutable page state lives in `ctx.s`.
//
// Split out of play.html's inline module by concern: playsetup.js (Setup and
// the admin tools), playview.js (the engine, the tiles, the ground and the
// player), playwhere.js (links, the address bar, the land under you),
// playbuild.js (Place, Your land, Shape), playapps.js (Automate and the other
// workspaces), playpublish.js (Submit, Work, Approve, Share), playxr.js,
// playticks.js (what is redrawn on a timer) and playframe.js (every frame).

import * as api from './api.js';
import { mountAuth } from './auth.js';
import { mountWork } from './workui.js';
import { mountHud } from './hud.js';
import { mountSetupSide } from './playsetup.js';
import { makeView, makeWorld } from './playview.js';
import { mountWhere } from './playwhere.js';
import { mountBuildSide } from './playbuild.js';
import { mountApps } from './playapps.js';
import { mountPublishSide } from './playpublish.js';
import { offerXr } from './playxr.js';
import { startTicks } from './playticks.js';
import { startFrames } from './playframe.js';

export async function startPlay(doc) {
    api.configure();
    const ctx = chrome(doc);
    try {
        await window.__pcReady;
    } catch {
        ctx.world.textContent = 'could not load the 3D engine — no network, and '
            + 'client/vendor/playcanvas is missing. Run `make vendor` once.';
        throw new Error('PlayCanvas did not load');
    }
    ctx.pc = window.pc;
    mountWorkPanel(ctx);
    await mountSetupSide(ctx);
    await makeView(ctx);
    makeWorld(ctx);
    mountWhere(ctx);
    mountBuildSide(ctx);
    mountApps(ctx);
    mountPublishSide(ctx);
    mountAuthPanel(ctx);
    offerXr(ctx);
    startTicks(ctx);
    startFrames(ctx);
    ctx.app.start();
    window.splatworld = handle(ctx);
}

// The chrome first: it owns the tabs, and every module below is mounted into
// one of them. Nothing is reachable by a key nobody told you about.
function chrome(doc) {
    const hud = mountHud(doc);
    const world = doc.createElement('p');
    world.id = 'world';
    world.className = 'muted mono';
    const panelFor = (tab, id) => {
        const host = doc.createElement('div');
        host.id = id;
        hud.panel(tab).append(host);
        return host;
    };
    return {
        api, doc, hud, world, panelFor,
        // WP5.2: the panel needs two things from the renderer — how long a
        // frame is taking, so background work can stand aside while the tab is
        // being played, and where the player is, so the nearest unfinished tile
        // is claimed first.
        frame: { ms: 0 },
        s: {
            // Set by a view that takes the window — Automate, Work, Survey:
            // while one is open the world is not drawn at all (hud.js onWindow).
            paused: false,
            // Where the last area_at was asked (playwhere.js).
            asked: { lon: 0, lat: 0, at: 0 },
            // The player drives the camera unless something else has taken the
            // wheel — the streaming tests script the camera directly.
            driving: true,
        },
    };
}

// What this machine is doing goes on the strip along the top, where a thing
// that is happening belongs; what it does with itself is the Settings tab of
// Work (design 8e). The panel itself is nothing but its queues.
function mountWorkPanel(ctx) {
    const { hud } = ctx;
    ctx.work = mountWork({
        frames: () => ctx.frame.ms,
        settings: hud.panel('Machine'),
        onState: (text, tone) => hud.machine(text, tone),
        where: () => {
            const p = ctx.camera.getPosition();
            const g = ctx.origin.geodeticOf({ x: p.x, y: p.y, z: p.z });
            return { lon: g.lon, lat: g.lat };
        },
    });
    // SPEC §3.12: a render this tab is holding goes back into the pool when the
    // tab goes away, rather than sitting in nobody's hands until the five-minute
    // expiry notices (db/0079_worktakenandgivenback.sql). pagehide, not unload:
    // unload never fires on a tab restored from the back-forward cache.
    window.addEventListener('pagehide', () => { ctx.work.loop()?.handBack(); });
}

function mountAuthPanel(ctx) {
    mountAuth(ctx.setup.account, {
        onChange: () => {
            // Who you are changes what the land under you says, and the answer
            // is cached until you walk somewhere else — so forget it.
            ctx.s.asked = { lon: 0, lat: 0, at: 0 };
            ctx.build.refresh(); ctx.areas.refresh(); ctx.showCredits();
            ctx.catalog.refresh(); ctx.admin.refresh(); ctx.symbols.list(); ctx.setup.refresh();
            ctx.cover.refresh();
            ctx.land.refresh(); ctx.assignLand.refresh(); ctx.attention.refresh();
            ctx.submit.refresh(); ctx.pool.refresh(); ctx.permission.refresh();
            ctx.sculpt.refresh();
            ctx.showWho();
        },
    });
}

// The handle the browser tests fly.
function handle(ctx) {
    const pick = ['app', 'pc', 'api', 'origin', 'streamer', 'camera', 'rows', 'terrain',
        'player', 'setDriving', 'work', 'groundMesh', 'hud', 'setup', 'admin', 'symbols',
        'catalog', 'land', 'submit', 'pool', 'permission', 'ground', 'share', 'goTo', 'spot',
        'build', 'preview', 'nearby', 'areas', 'wallet', 'flows', 'sculpt', 'liveDraw',
        'triggers', 'peers', 'hosting', 'movers', 'moverDraw'];
    const out = Object.fromEntries(pick.map((k) => [k, ctx[k]]));
    out.live = ctx.liveWorld;
    out.xr = { wants: ctx.wantsXr, rig: () => ctx.s.rig ?? null };
    return out;
}
