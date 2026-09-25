// playxr.js — WP5.4, the headset (play.js).
//
// The rig is made only when a session starts: outside one the camera is exactly
// where it was, and every other test in this repo flies it the same way it
// always did. In a session the pose drives the camera, so locomotion moves the
// rig under it and the player loop stands down. Teleport is the only
// locomotion offered — smooth motion in a headset is what makes people sick.
//
// Not run on a headset: there is none here. docs/xr.md says what to check.

import { XR_LIMITS, teleportTarget, xrSupported } from './xr.js';

export async function offerXr(ctx) {
    ctx.setDriving = (v) => { ctx.s.driving = v; };
    const panel = ctx.panelFor('Setup', 'xr');
    panel.hidden = true;
    panel.innerHTML = '<button type="button" class="xr-enter">enter VR</button>'
        + ' <span class="xr-status muted"></span>';
    if (!ctx.wantsXr) return;
    const { app, pc } = ctx;
    panel.hidden = false;
    const status = panel.querySelector('.xr-status');
    const ok = await xrSupported() && app.xr?.isAvailable(pc.XRTYPE_VR);
    if (!ok) {
        panel.querySelector('.xr-enter').disabled = true;
        status.textContent = 'no headset on this browser';
        return;
    }
    status.textContent = `${XR_LIMITS.splatBudget / 1e6} M splat budget`;
    panel.querySelector('.xr-enter').onclick = () => enter(ctx, status);
    app.xr.on('end', () => { ctx.setDriving(true); status.textContent = 'left VR'; });
    // A trigger pull is a teleport: where the controller points, if that is
    // ground this tab has actually streamed.
    app.xr.input?.on('select', (source) => {
        const o = source.getOrigin();
        const d = source.getDirection();
        const to = teleportTarget(ctx.terrain, { x: o.x, y: o.y, z: o.z },
            { x: d.x, y: d.y, z: d.z });
        if (!to) { status.textContent = 'no ground there'; return; }
        ctx.s.rig.setPosition(to.x, to.y - ctx.camera.getLocalPosition().y, to.z);
        ctx.player.position = { x: to.x, y: to.y, z: to.z };
    });
}

function enter(ctx, status) {
    const { app, pc, camera } = ctx;
    const rig = ctx.s.rig ?? new pc.Entity('xr-rig');
    ctx.s.rig = rig;
    if (!rig.parent) app.root.addChild(rig);
    const p = camera.getPosition().clone();
    camera.reparent(rig);
    camera.setLocalPosition(0, 0, 0);
    rig.setPosition(p);
    ctx.setDriving(false);
    app.xr.start(camera.camera, pc.XRTYPE_VR, pc.XRSPACE_LOCALFLOOR, {
        callback: (err) => { if (err) status.textContent = String(err.message ?? err); },
    });
}
