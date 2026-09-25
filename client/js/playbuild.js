// playbuild.js — what is built and where: the preview of placed things, the
// wallet, what is live and what moves, Place, Your land and Shape (play.js).

import * as tm from '../lib/tilemath.js';
import { nearbyInstances } from './build.js';
import { mountBuild } from './buildui.js';
import { InstancePreview } from './preview.js';
import { mountWallet } from './walletui.js';
import { LiveWorld } from './live.js';
import { LiveDraw } from './livedraw.js';
import { Movers } from './movers.js';
import { MoverDraw } from './moverdraw.js';
import { mountGetLand } from './getland.js';
import { mountLand } from './land.js';
import { mountSculpt } from './sculptui.js';
import { landChanged } from './playwhere.js';

export function mountBuildSide(ctx) {
    const { app, pc, api, origin, hud } = ctx;
    // WP4.2: build mode. The preview draws what has been placed but not yet
    // compiled — a published tile is splats, and a bench put down a second ago
    // is in none of them until some tab renders that tile again.
    ctx.preview = new InstancePreview(app, pc, { origin, filesUrl: api.endpoints().files });
    ctx.nearby = (lon, lat) => nearby(ctx, lon, lat);
    // WP4.4: the wallet, and the bounty that puts a tile in front of a
    // stranger. Whatever the wallet learns, the corner of the chrome says — so
    // a balance that changed because a bounty was paid does not wait for a
    // sign-in.
    ctx.s.held = null;
    ctx.wallet = mountWallet(ctx.panelFor('Wallet', 'wallet'), {
        onBalance: (account) => {
            ctx.s.held = account ? Number(account.amount) : null;
            hud.stat('credits', ctx.s.held === null ? '—' : ctx.s.held.toFixed(2));
            ctx.profile?.refresh();
        },
    });
    ctx.showCredits = () => ctx.wallet.refresh();
    ctx.showCredits();
    // FND.15: what a placed thing is doing right now — a lamp lit, a screen
    // showing something — over the splats the compiler baked without it.
    ctx.liveWorld = new LiveWorld();
    ctx.liveDraw = new LiveDraw(app, pc, { preview: ctx.preview, filesUrl: api.endpoints().files });
    // FND.16: the things that move by the world's own clock. Where each is now
    // is worked out from its route and its timetable, so nothing is stored per
    // frame and two players see the same bus at the same second.
    ctx.movers = new Movers();
    ctx.moverDraw = new MoverDraw(app, pc, { preview: ctx.preview, origin });
    mountPlace(ctx);
    mountYourLand(ctx);
    mountShape(ctx);
}

// An instance row plus the digest of the asset's canonical GLB, which is what
// both the preview and `assemble` actually draw.
async function nearby(ctx, lon, lat) {
    const rows = await nearbyInstances(lon, lat).catch(() => []);
    if (!rows.length) return rows;
    const sans = [...new Set(rows.map((r) => r.san))];
    // FND.15: and its markings, which say which of its parts are live.
    const assets = await ctx.api.select('asset',
        { san: `in.(${sans.join(',')})`, select: 'san,sha256,parts' }).catch(() => []);
    const bySan = new Map(assets.map((a) => [a.san, a]));
    return rows.filter((r) => bySan.has(r.san))
        .map((r) => ({ ...r, sha256: bySan.get(r.san).sha256,
            parts: bySan.get(r.san).parts ?? {} }));
}

function mountPlace(ctx) {
    const { hud } = ctx;
    ctx.build = mountBuild(ctx.panelFor('Place', 'build'), {
        app: ctx.app, pc: ctx.pc, api: ctx.api, camera: ctx.camera, origin: ctx.origin,
        terrain: ctx.terrain, streamer: ctx.streamer, player: ctx.player, work: ctx.work,
        preview: ctx.preview, canvas: ctx.canvas, nearby: ctx.nearby, wallet: ctx.wallet,
        movers: ctx.movers,
        // FL.6: a thing's Flows section opens Automate on one of them, or on a
        // new one made for it. `flows` is mounted later; these run on a press.
        automate: {
            open: async (row) => { hud.app('Automate'); await ctx.flows.openFlow(row); },
            create: async (area, name, instance) => {
                hud.app('Automate');
                await ctx.flows.createFor(area, name, instance);
            },
        },
        live: { wrote: (id, port, done) => {
            ctx.liveWorld.wrote(id, port, done.value, done.rev);
            ctx.liveDraw.apply(ctx.liveWorld);
        } },
    });
}

function mountYourLand(ctx) {
    const { hud } = ctx;
    // SPEC §2.4 "Get land": somebody with none is told who hands it out, and
    // given the one thing they can do about it. Mounted before the list, so the
    // list's first refresh has something to hand its areas to.
    const getland = mountGetLand(hud.panel('Your land'));
    // T5: the land you own, outlined in the world and listed in the panel, with
    // what stands on it. Going to something puts you in front of it.
    ctx.land = mountLand(hud.panel('Your land'), {
        onGo: (item) => {
            const p = ctx.origin.localOf({ lon: item.lon, lat: item.lat, h: item.h ?? 0 });
            ctx.player.position = { x: p.x, y: p.y + 2, z: p.z + 8 };
        },
        onAreas: (areas) => { landChanged(ctx, areas); getland.refresh(areas); },
        openPanel: (name) => hud.show(name),
        onRemove: (item) => ctx.api.remove('instance', { id: `eq.${item.id}` })
            .then(() => ctx.build.refresh()),
    });
}

// FND.9: the ground itself, shaped in the page. It is a mode the 3D view is in
// while the panel is open, the way Place is, and what it changes is the land's
// own grid of relative metres (client/js/sculpt.js).
function mountShape(ctx) {
    const { terrain, origin } = ctx;
    const shaped = (lon, lat) => ctx.sculpt.shaping()?.at(lon, lat) ?? 0;
    ctx.sculpt = mountSculpt(ctx.hud.panel('Shape'), {
        canvas: ctx.canvas, camera: ctx.camera, pc: ctx.pc, app: ctx.app, origin, terrain,
        player: ctx.player,
        groundAt: (lon, lat) => terrain.heightAt(origin.localOf({ lon, lat, h: 0 })) ?? 0,
        onShaped: () => ctx.groundMesh?.reshape(shaped, tilesOfShaping(ctx)),
        // FND.9: shaping on or off. What is shaped is the mesh, so while it is
        // on the splats over that land are put away and the mesh is what is on
        // screen — and put back the moment it is off (client/js/tiles.js).
        onMode: (on) => {
            const tiles = on ? tilesOfShaping(ctx) : [];
            ctx.groundMesh?.reshape(shaped, tiles);
            // Only where there is a mesh to put in their place: a world whose
            // operator has published no elevation has no DemGround at all
            // (playview.js), and taking the splats off that land would leave a
            // hole with nothing in it rather than ground to shape.
            ctx.streamer.hideUnder(ctx.groundMesh ? tiles.map((k) => `14/${k}`) : []);
        },
        onSaved: () => { ctx.build.refresh(); ctx.submit.refresh(); },
    }, { lands: () => ctx.api.rpc('my_areas').catch(() => []) });
}

// The z14 tiles the land being shaped falls in: they are drawn as ground while
// Shape is on even where a published tile covers them, because you cannot
// shape ground you cannot see.
function tilesOfShaping(ctx) {
    const b = ctx.sculpt.shaping()?.area?.bbox;
    if (!b) return [];
    const out = [];
    for (let x = tm.tileX(b.west, 14); x <= tm.tileX(b.east, 14); x++) {
        for (let y = tm.tileY(b.north, 14); y <= tm.tileY(b.south, 14); y++) out.push(`${x}/${y}`);
    }
    return out;
}
