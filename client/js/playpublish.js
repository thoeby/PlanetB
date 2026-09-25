// playpublish.js — from what you built to what everybody sees: Submit, the
// render pool, Approve, and the links you hand out (play.js).

import { mountAreas } from './areasui.js';
import { mountPlaces } from './places.js';
import { mountPool, mountSubmit } from './pool.js';
import { mountPermission } from './permission.js';
import { mountShare } from './visit.js';
import { mountDuties } from './dutiesui.js';
import { mountHosting } from './hostingui.js';
import { resumeHosting } from './hosting.js';

// Where the camera stands, on the earth.
const whereNow = (ctx) => {
    const p = ctx.camera.getPosition();
    return ctx.origin.geodeticOf({ x: p.x, y: p.y, z: p.z });
};

// Put the player on the ground in front of a place, looking north.
const standBefore = (ctx, at, back) => {
    const p = ctx.origin.localOf({ lon: at.lon, lat: at.lat, h: 0 });
    ctx.player.position = { x: p.x, y: (ctx.terrain.heightAt(p) ?? p.y) + 2, z: p.z + back };
    ctx.player.yaw = 0;
};

export function mountPublishSide(ctx) {
    const { hud } = ctx;
    ctx.s.onMyLand = null;
    mountSubmitPanel(ctx);
    mountPoolPanels(ctx);
    // FND.16: opening Place is looking at where you are — what you may do
    // here, what is waiting to be submitted, and what runs over this ground. A
    // panel that shows what was true when the tab loaded is a panel nobody can
    // read.
    hud.whenShown('Place', () => ctx.build.refresh());
    hud.whenShown('Your land', () => ctx.land.refresh());
    hud.whenShown('Submit', () => ctx.submit.refresh());
    mountPermissionPanel(ctx);
    // SPEC §2.3: the map's search box. A name is how you find a place somebody
    // told you about without a link to it.
    mountPlaces(hud.mapBox(), { onGo: (place) => ctx.goTo(place) });
    // T8: the link, to hand to somebody.
    ctx.share = mountShare(hud.panel('Share'), {
        where: () => ({ ...whereNow(ctx), heading: ctx.player.heading }),
    });
    // WP4.3's grants and proposals live in the Your land panel itself now
    // (design 3b): one card per area, with the people on it and what is waiting
    // for a decision. The old module stays mounted for the one thing the card
    // does not do — merging a proposal — in a tab of its own under Permission,
    // where deciding already happens.
    ctx.areas = mountAreas(ctx.panelFor('Permission', 'areas'), {
        onSelect: () => { ctx.build.refresh(); ctx.land.refresh(); },
    });
}

// T6: what you built has to be compiled before anybody else can see it.
// Submit puts your tiles in a public pool at a price; the pool is where
// anybody's tab takes them.
function mountSubmitPanel(ctx) {
    const { hud, terrain, origin } = ctx;
    ctx.submit = mountSubmit(hud.panel('Submit'), {
        // Something was sent for a decision: the person who decides may be
        // this same player, and the panel that shows it is one tab away.
        onSubmitted: () => { ctx.pool.refresh(); ctx.land.refresh(); ctx.permission.refresh(); },
        // FND.11: the roads that cannot be driven across, measured here with
        // the compiler's own code before the approver is shown them.
        ground: (lon, lat) => terrain.heightAt(origin.localOf({ lon, lat, h: 0 })) ?? 0,
        onGo: (at) => {
            const p = origin.localOf({ lon: at.lon, lat: at.lat, h: at.h ?? 0 });
            ctx.player.position = { x: p.x, y: p.y + 2, z: p.z + 8 };
        },
        onCount: (p) => {
            // The route through the app, as the chrome shows it. Every number
            // is one area_progress already reports; none is invented here.
            hud.stat('placed', String(ctx.land.things?.().length ?? 0));
            hud.stat('pool', `${p.open_jobs ?? 0} tiles`);
            // The tiles this land is compiled into, not every tile whose box
            // overlaps it: the z6 one over a Valais hillside is six hundred
            // kilometres across and belongs to everybody, and counting it
            // among a half-hectare's twenty-two read as "you own twenty-two
            // tiles" (db/0087).
            hud.stat('rendered', `${p.leaves_published ?? 0} / ${p.leaves ?? 0}`);
            hud.stat('published', String(p.leaves_published ?? 0));
            // A tile exists where something stands, so this is how many things
            // are on the land that is chosen in the panel — nothing, and there
            // is nothing to submit however much land you own.
            ctx.s.onMyLand = p.leaves;
        },
    });
}

// The pool is a queue other tabs are taking work out of, so what it showed
// when the page loaded is not what is in it now: opening the tab asks again.
function mountPoolPanels(ctx) {
    const { hud, work } = ctx;
    const queues = ['Every job', 'Render jobs', 'Training', 'Publishing'];
    ctx.pool = mountPool(Object.fromEntries(queues.map((q) => [q, hud.panel(q)])), {
        loop: () => work.ready(),
        // What just happened to a job is said once, above the queues, rather
        // than four times over in four tabs.
        statusHost: hud.panelHead('Work'),
        count: (name, n) => hud.partCount(name, n),
        // The same hillshade the corner map draws, under the tile a job is
        // about (client/js/jobdetail.js).
        ground: () => ctx.floor,
        where: () => whereNow(ctx),
        // SPEC §2.9's move, on a tile instead of a submission: put me where I
        // can see the ground this job is about.
        onGo: (at) => { if (at?.lon !== undefined) standBefore(ctx, at, 12); },
    });
    // Which card is lit, and what it says this machine is doing to it, follow
    // the loop rather than the refresh (design 8a).
    work.onLog(() => ctx.pool.note());
    // Opening a tab is asking what is there now. The world changes outside
    // this page — somebody draws in QGIS, somebody else's tab renders a tile —
    // and a panel that answers from what it knew at load time tells the player
    // that nothing has changed since they last sent it, which is the one thing
    // they know to be untrue.
    for (const queue of queues) hud.whenShown(queue, () => ctx.pool.look(queue));
    hud.whenShown('Machine', () => work.progress());
    // LV.10: flows offered to the pool, run on a server of yours.
    ctx.duties = mountDuties(hud.panel('Flows to run'));
    hud.whenShown('Flows to run', () => ctx.duties.refresh());
    // LV.13: a land's files, kept by this tab for a term; a reload keeps them.
    ctx.hosting = mountHosting(hud.panel('Hosting'), { peers: ctx.peers });
    hud.whenShown('Hosting', () => ctx.hosting.refresh());
    ctx.peers.start().then((ok) => ok && resumeHosting(ctx.peers));
}

// T7: what has been rendered on your land and is waiting for you to say yes.
function mountPermissionPanel(ctx) {
    const { hud } = ctx;
    ctx.permission = mountPermission(hud.panel('Permission'), {
        preview: ctx.preview,
        // SPEC §2.9: Review flies you there — to the ground, looking at what
        // was built. Sixty metres above it, which is where this used to land
        // you, is a place from which you cannot see what you are being asked
        // about.
        onGo: (centre) => { if (centre.lon !== undefined) standBefore(ctx, centre, 12); },
        where: () => whereNow(ctx),
        onDecided: () => { ctx.land.refresh(); ctx.submit.refresh(); },
        onCount: (n) => {
            hud.badge('Permission', n);
            hud.stat('awaiting', String(n));
        },
    });
    hud.whenShown('Permission', () => ctx.permission.refresh());
}
