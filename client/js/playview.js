// playview.js — the engine, the camera, the tiles, the ground and the player
// (play.js).

import { FloatingOrigin } from './origin.js';
import { LIMITS, TileStreamer, WEBGL_LIMITS } from './tiles.js';
import { Player, Terrain, WALK } from './player.js';
import { SpotChecker } from './spot.js';
import { XR_LIMITS, xrRequested } from './xr.js';
import { mountSky } from './sky.js';
import { DemFloor } from './floor.js';
import { DemGround } from './ground.js';
import { Peers } from './peers.js';
import { peerFetch } from './peerfetch.js';

const TILE_COLUMNS = 'z,x,y,dirty,published_version,sog_sha256,manifest,'
    + 'candidate_version,candidate_sha256,candidate_manifest';

export async function makeView(ctx) {
    const { api, ground } = ctx;
    // Reading tiles needs no token: everyone reads the world (db/0003_rls.sql).
    // Every row is fetched, not only the published ones — the traversal has to
    // tell an unpublished child from one that does not exist.
    ctx.rows = await api.selectAll('tile', { select: TILE_COLUMNS, order: 'z,x,y' })
        .catch((err) => {
            ctx.world.textContent = `api unreachable (${api.endpoints().api}): ${err.message}`;
            return [];
        });
    ctx.live = ctx.rows.filter((r) => r.published_version > 0 && r.manifest?.origin);
    const anchor = (ctx.live.find((r) => r.z === 10) ?? ctx.live[0])?.manifest.origin
        ?? (ground?.centre ? { ...ground.centre, h: 0 } : { lon: 0, lat: 0, h: 0 });
    ctx.origin = new FloatingOrigin(anchor);
    await makeDevice(ctx);
    makeCamera(ctx);
}

// A WebGPU adapter that is a software renderer (SwiftShader, which is what a
// runner with no GPU has once --enable-unsafe-webgpu is on) takes the renderer
// process down with it the moment the engine makes a device on it: "A valid
// external Instance reference no longer exists", and the page is gone before
// its first frame. Such a tab draws on WebGL2, which ANGLE over SwiftShader
// does render. The trainer, which needs WebGPU for its compute, makes its own
// device in its own worker and is not affected.
async function softwareGpu() {
    const adapter = await navigator.gpu?.requestAdapter?.().catch(() => null);
    const info = adapter?.info ?? {};
    return /swiftshader|software|llvmpipe|lavapipe/i.test(
        `${info.architecture ?? ''} ${info.device ?? ''} ${info.description ?? ''}`);
}

// WebGPU where the browser has it, WebGL2 otherwise. The difference is not
// cosmetic: with WebGL2 the engine sorts every splat on the CPU and reads each
// new tile's centres back from the GPU synchronously, which is the stall felt
// whenever a tile lands. With WebGPU both happen on the device. A headset
// session stays on WebGL2, the path the engine's XR is built on.
async function makeDevice(ctx) {
    const { pc } = ctx;
    ctx.wantsXr = xrRequested(location.search);
    ctx.canvas = ctx.doc.getElementById('view');
    const noWebgpu = ctx.wantsXr || await softwareGpu();
    ctx.device = await pc.createGraphicsDevice(ctx.canvas, {
        deviceTypes: noWebgpu ? [pc.DEVICETYPE_WEBGL2]
            : [pc.DEVICETYPE_WEBGPU, pc.DEVICETYPE_WEBGL2],
        antialias: false, powerPreference: 'high-performance',
        xrCompatible: Boolean(navigator.xr),
    });
    ctx.app = new pc.Application(ctx.canvas, { graphicsDevice: ctx.device });
    ctx.app.setCanvasFillMode(pc.FILLMODE_FILL_WINDOW);
    ctx.app.setCanvasResolution(pc.RESOLUTION_AUTO);
}

function makeCamera(ctx) {
    const { pc, app } = ctx;
    const camera = new pc.Entity('camera');
    camera.addComponent('camera', {
        fov: 45, nearClip: 0.3, farClip: 5e7,
        clearColor: new pc.Color(0.05, 0.06, 0.07),
    });
    camera.setPosition(0, 2000, 0);
    camera.setEulerAngles(-90, 0, 0); // straight down until the player takes over
    app.root.addChild(camera);
    ctx.camera = camera;
    // The sky and the air (client/js/sky.js): the viewer's, not the tiles'. A
    // sky that cannot be drawn is a sky the page goes on without.
    ctx.sky = { follow() {} };
    try { ctx.sky = mountSky(app, pc, camera); } catch (err) { console.error('sky', err); }
}

export function makeWorld(ctx) {
    makeStreamer(ctx);
    // WP3.3: the tab re-checks the tiles it is looking at but did not publish.
    // It sweeps whether or not anyone is signed in — spot_due answers nothing
    // to an anonymous tab — and never while the work panel has an atom in hand.
    const { api, work } = ctx;
    ctx.spot = new SpotChecker({
        api, apiUrl: api.endpoints().api, filesUrl: api.endpoints().files, log: work.log,
    });
    ctx.spot.start(ctx.streamer, { busy: () => Boolean(work.loop()?.atom) });
    makeGround(ctx);
}

function makeStreamer(ctx) {
    const { api, app, pc } = ctx;
    // WP1.5: the loaded tiles are re-checked every 30 s, and so is whatever was
    // published since the last check — a tile trained while this page is open
    // is what the parent refines into next. PostgREST takes the set as one
    // `or=(...)` filter, so it is one request however many tiles are on screen.
    const fetchRows = (loaded, since) => api.select('tile', {
        select: TILE_COLUMNS,
        or: `(${[...loaded.map((t) => `and(z.eq.${t.z},x.eq.${t.x},y.eq.${t.y})`),
            `published_at.gt.${encodeURIComponent(since)}`].join(',')})`,
    });
    // WP5.4: a headset draws the world twice at ninety frames a second, so
    // ?xr=1 halves the tile count and takes a third of the splats (js/xr.js).
    // The budget is lowered by the flag rather than by the session, because the
    // tiles have to be loaded before there is anything to enter. Without a
    // headset the budget follows the device (traverse.js WEBGL_LIMITS).
    const limits = ctx.wantsXr ? XR_LIMITS : ctx.device.isWebGPU ? LIMITS : WEBGL_LIMITS;
    // How many splats the engine may draw at once, across every tile on screen.
    // A tile carries its own levels (client/atoms/sog.js) and the engine spends
    // this across all of them, so a tile that does not fit is drawn coarse
    // instead of being left out — which is what the traversal used to do, and
    // why the ground at the edge of the view went missing rather than going
    // soft (client/js/traverse.js applyTileCap).
    app.scene.gsplat.splatBudget = limits.splatBudget;
    // LV.12: this tab is a peer. What it reads from the store it asks the
    // other open tabs for first, by CID, and keeps and serves while it is
    // open (client/js/peers.js); a tab that cannot be one reads by HTTP as
    // before. `peerSay` is the triggers' line once they are mounted.
    ctx.peerSay = () => {};
    ctx.peers = new Peers({ filesUrl: api.endpoints().files,
        say: (text, bad) => ctx.peerSay(text, bad),
        where: () => {
            const p = ctx.camera.getPosition();
            return ctx.origin.geodeticOf({ x: p.x, y: p.y, z: p.z });
        } });
    ctx.peers.start();
    ctx.fromPeers = peerFetch(ctx.peers);
    ctx.streamer = new TileStreamer(app, pc, {
        origin: ctx.origin, filesUrl: api.endpoints().files, fetchRows, limits,
    });
    ctx.streamer.peerFetch = ctx.fromPeers;
    ctx.streamer.setTiles(ctx.rows);
    ctx.streamer.startPolling();
}

function makeGround(ctx) {
    const { api, ground, app, pc, hud } = ctx;
    // The floor is the finest published tile's height file, and where nothing
    // is published yet, the elevation itself (client/js/floor.js): read, not
    // drawn. Every z14 tile of the ground is compiled (db/0104), so the second
    // is only ever a stopgap. `version` is when the ground was last cut
    // (db/0154): a cut is served immutable and for a year, so the same ground
    // under a new survey has to be asked for under a new name or the tab never
    // sees it.
    ctx.floor = ground?.coverage
        ? new DemFloor({ filesUrl: api.endpoints().files, version: ground.set_at ?? '' })
        : null;
    ctx.terrain = new Terrain(ctx.streamer, { ground: ctx.floor, fetchFn: ctx.fromPeers });
    // SPEC §0.1: ground is always drawn. Where no published tile covers it,
    // the same elevation is drawn as plain terrain (client/js/ground.js).
    ctx.groundMesh = ctx.floor
        ? new DemGround(app, pc, { origin: ctx.origin, floor: ctx.floor, streamer: ctx.streamer })
        : null;
    ctx.player = new Player(ctx.terrain, { mode: WALK });
    // The corner says which way you are moving and what the keys do about it:
    // Shift runs on the ground and goes down in the air, and forward follows
    // where you are looking only in the air.
    ctx.player.onMode = (mode) => hud.moving(mode);
    hud.moving(ctx.player.mode);
    ctx.player.attach(ctx.canvas);
}
