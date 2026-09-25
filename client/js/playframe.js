// playframe.js — what happens every frame (play.js).

import * as tm from '../lib/tilemath.js';
import { cameraState } from './tiles.js';
import { drawAreas, labelAreas, labelObjects } from './land.js';
import { keepTheAddressBar, whereAmI } from './playwhere.js';

// Whether the tile under a thing has been published with it inside. The
// streamer already holds every tile row; `dirty` is the world's own answer.
function unrendered(streamer, row) {
    if (row.placing) return false;
    for (let i = tm.ZOOMS.length - 1; i >= 0; i--) {
        const z = tm.ZOOMS[i];
        const t = streamer.tiles.get(`${z}/${tm.tileX(row.lon, z)}/${tm.tileY(row.lat, z)}`);
        if (t) return Boolean(t.dirty) || !(t.published_version > 0);
    }
    return true;
}

export function startFrames(ctx) {
    // The traversal is re-run when the view changes or a load settles, and
    // every tenth frame regardless; on the other frames the streamer only
    // places what has arrived. Camera pose is compared as a string: cheap, and
    // exact.
    const f = { lastPose: '', lastPending: -1, lastHud: '', tick: 0,
        // A mover whose GLB is still being fetched must not be asked for again
        // on the next frame; the promise is the guard.
        placing: null };
    ctx.app.on('update', (dt) => {
        // A workspace has the window; nothing is drawn or streamed under it.
        if (ctx.s.paused) return;
        // A smoothed frame time, so one slow frame does not stall background
        // work and one fast one does not let it back in too early.
        ctx.frame.ms = ctx.frame.ms ? ctx.frame.ms * 0.9 + dt * 1000 * 0.1 : dt * 1000;
        const p = move(ctx, dt);
        drawOverlays(ctx, f);
        stream(ctx, f, p);
        tellWhere(ctx, f, p);
    });
}

// The player drives the camera, the sky follows it, and the floating origin
// rebases under it when it has gone far enough.
function move(ctx, dt) {
    const { camera, player, s } = ctx;
    if (s.driving) {
        player.update(dt);
        const q = player.position;
        camera.setPosition(q.x, q.y, q.z);
        camera.setEulerAngles(player.pitch / Math.PI * 180, player.yaw / Math.PI * 180, 0);
    }
    const p = camera.getPosition();
    ctx.sky.follow(p);
    const moved = ctx.streamer.rebase({ x: p.x, y: p.y, z: p.z });
    if (moved) {
        camera.setPosition(moved.x, moved.y, moved.z);
        if (s.driving) player.position = { ...moved };
        ctx.preview.rebased();
        ctx.groundMesh?.rebased();
    }
    ctx.groundMesh?.update(camera.getPosition());
    return camera.getPosition();
}

function drawOverlays(ctx, f) {
    const { pc, app, origin, terrain, land } = ctx;
    // FND.16: every mover put where this second says it is. Nothing is stored
    // per frame — the clock and the route say where it is, for everybody.
    // LV.1: and every moving part where the same clock puts it.
    ctx.liveDraw.tick(ctx.liveWorld, ctx.movers.clock());
    if (!f.placing) {
        const groundUnder = (lon, lat) =>
            terrain.heightAt(origin.localOf({ lon, lat, h: 0 })) ?? 0;
        f.placing = ctx.moverDraw.place(ctx.movers.where(), groundUnder)
            .finally(() => { f.placing = null; });
    }
    ctx.build.drawGizmo();
    // FND.9: the brush, on the ground, where the pointer is.
    ctx.sculpt.drawBrush();
    drawAreas({ pc, app, origin, terrain }, land.areas());
    const labels = ctx.doc.getElementById('world-labels');
    labelAreas({ pc, app, origin, terrain }, land.areas(), labels);
    // SPEC §0.3: a saved object is everybody's to see, marked "not yet
    // rendered" until its tile is published with it inside. A dirty tile is
    // exactly "something here changed since the last publish".
    labelObjects({ pc, app, origin, terrain },
        [...ctx.preview.rows.values()].filter((row) => unrendered(ctx.streamer, row)), labels);
}

function stream(ctx, f, p) {
    const { camera, streamer } = ctx;
    const r = camera.getRotation();
    const pose = `${p.x.toFixed(1)} ${p.y.toFixed(1)} ${p.z.toFixed(1)} `
        + `${r.x.toFixed(3)} ${r.y.toFixed(3)} ${r.z.toFixed(3)} ${r.w.toFixed(3)}`;
    f.tick++;
    if (f.tick % 6 === 0) ctx.triggers.tick();
    if (pose !== f.lastPose || streamer.pending !== f.lastPending || f.tick % 10 === 0) {
        f.lastPose = pose;
        streamer.update(cameraState(camera, ctx.app.graphicsDevice.height, ctx.pc));
        f.lastPending = streamer.pending;
    } else {
        streamer.placeNext();
    }
}

// Where you are, in the chrome: the compass follows the camera, the
// coordinates are the real ones, and the land under you is asked for only when
// you have actually walked somewhere else.
function tellWhere(ctx, f, p) {
    const { hud, player, streamer, origin } = ctx;
    const here = origin.geodeticOf({ x: p.x, y: p.y, z: p.z });
    const heading = player.heading;
    hud.at(here.lon, here.lat, here.h, heading);
    // The altimeter: how high you are above the sea, and how far that is above
    // whatever is under you. The ground comes from the same heightfield walking
    // stands on, so the two never disagree; null where nothing has loaded.
    const under = ctx.terrain.heightAt({ x: p.x, y: p.y, z: p.z });
    hud.height({
        altitude: here.h,
        above: under === null ? null : p.y - under,
        pitch: player.pitch / Math.PI * 180,
    });
    whereAmI(ctx, here);
    keepTheAddressBar(ctx, { ...here, heading });
    const status = `${ctx.live.length} published tiles — ${ctx.device.deviceType}\n`
        + `${streamer.entries.size} loaded, ${streamer.pending} loading\n`
        + `${origin.rebases} rebases, ${streamer.swaps} swaps — ${player.mode}`
        + `${player.grounded ? '' : ' (no ground yet)'}`;
    if (status !== f.lastHud) ctx.world.textContent = f.lastHud = status;
}
