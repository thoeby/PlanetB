// playapps.js — the workspaces that take the window (Automate, Work, Survey)
// and Profile (play.js).

import { mountFlows } from './flowsui.js';
import { mountPickWorld } from './pickworld.js';
import { mountProfile } from './profileui.js';

// While a workspace has the window the world is neither drawn nor streamed
// (client/js/hud.js onWindow, client/frame.css).
function pause(ctx, on) {
    ctx.s.paused = on;
    ctx.app.autoRender = !on;
}

export function mountApps(ctx) {
    mountAutomate(ctx);
    const { hud } = ctx;
    // And the other workspaces that take the window get the same: Work and
    // Survey are a window of their own, so the world under them is not drawn.
    // Automate is left to its own handler — it opens and closes its own window
    // and says so itself.
    hud.onWindow((takes) => {
        if (hud.app() === 'Automate') return;
        pause(ctx, takes);
    });
    // Design 5e: who you are in the world, and what that comes to. It reads
    // what the other panels already know, so it holds no state of its own.
    ctx.profile = mountProfile(hud.panel('Profile'), {
        claims: () => ctx.api.claims(),
        balance: () => ctx.s.held,
        lands: () => ctx.land.areas() ?? [],
        things: () => ctx.land.things?.() ?? [],
        open: (name) => hud.show(name),
    });
    hud.whenShown('Profile', () => ctx.profile.refresh());
    // Survey is the F6 view now, not a tab of Settings: opening it is somebody
    // asking who is waiting for land and where it is, and both go stale while
    // the view is closed.
    hud.whenShown('Land', () => ctx.assignLand.refresh());
}

// SPEC §2.16: Automate is a workspace of its own rather than a panel, so it
// takes the window and the world stops being drawn under it. litegraph is
// fetched the first time it is opened, not now (client/flow/boot.js).
// FND.14: "Pick in world". Automate hides itself, the world is drawn again with
// the cursor free, and build mode's own ray says what was clicked.
function mountAutomate(ctx) {
    const { hud, doc } = ctx;
    const pickWorld = mountPickWorld(doc.getElementById('hud') ?? doc.body, {
        canvas: ctx.canvas,
        pick: (screen) => ctx.build.pick(screen),
        before: () => {
            pause(ctx, false);
            ctx.player.detach();
            doc.exitPointerLock?.();
        },
        after: () => {
            pause(ctx, true);
            // Build mode has the pointer of its own while it is on; otherwise
            // the world takes it back, or nothing moves once Automate is closed.
            if (!ctx.build.state.on) ctx.player.attach(ctx.canvas);
        },
    });
    ctx.flows = mountFlows(doc, {
        lands: () => ctx.api.rpc('my_areas').catch(() => []),
        pickObject: (where) => pickWorld.ask(where),
        onOpen: () => pause(ctx, true),
        onClose: () => {
            pause(ctx, false);
            if (hud.app() === 'Automate') hud.app('Build');
        },
        onStay: () => { if (hud.app() !== 'Automate') hud.app('Automate'); },
    });
    hud.onApp((name) => { if (name === 'Automate') ctx.flows.show(); else ctx.flows.close(); });
}
