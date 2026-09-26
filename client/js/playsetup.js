// playsetup.js — Setup, the admin's tools, and what is waiting for you:
// everything the page mounts before there is a world to draw (play.js).

import { mountSetup } from './setupui.js';
import { mountAdmin } from './adminui.js';
import { mountSymbols } from './symbolsui.js';
import { mountCover } from './coverui.js';
import { mountMarketplace } from './catalogpanel.js';
import { mountInventory } from './inventory.js';
import { mountAssignLand } from './assignland.js';
import { mountAttention } from './attention.js';

export async function mountSetupSide(ctx) {
    const { api, hud } = ctx;
    // Where the world is. Until somebody picks a coverage there is nowhere to
    // stand, and the Setup panel is what the tab opens on (T0).
    ctx.ground = await api.rpc('ground').catch(() => ({}));
    ctx.setup = mountSetup(hud.panel('Setup'), {
        // Onto the world, not back to where the crosshair was pointing while
        // there was no world: an empty page writes #at=0,0 into the address
        // bar, and reloading with it carried the operator to null island the
        // moment they picked their ground (SPEC §3.1 step 3).
        onGround: () => { location.replace(location.pathname); },
        // Cutting the same ground again does not move the world; what it
        // changes is every copy of it this tab is holding (db/0154). The ground
        // under your feet, the map in the corner and the admin's map all read
        // the elevation, and all three had a year's worth of it cached.
        onRecut: (g) => {
            ctx.floor?.forget(g?.set_at ?? '');
            ctx.groundMesh?.rebuild();
            ctx.drawTheMap();
            ctx.assignLand.refresh();
        },
    });
    // What the streamer is doing, under the three steps it is the result of.
    hud.panel('Setup').append(ctx.world);
    // SPEC §3.2: land is assigned by an admin, who draws it on the map here.
    // First in the panel, because it is the only thing in it that somebody
    // else is waiting for.
    ctx.assignLand = mountAssignLand(hud.panel('Land'), { filesUrl: api.endpoints().files });
    // What the world may say about itself. The same rows drive this tool's
    // forms, QGIS's layer forms and the rules the compiler matches on (T3).
    ctx.admin = mountAdmin(hud.panel('Vocabulary'), { openPart: (name) => hud.show(name) });
    // What the compiler lays down where a thing is drawn. It was the other half
    // of the Vocabulary part until FND.7 made a rule a stack of layers, which
    // needs a part of its own.
    ctx.symbols = mountSymbols(hud.panel('Symbols'));
    ctx.cover = mountCover(hud.panel('Ground cover'));
    // Who you are, in the corner, from the moment the page knows.
    ctx.showWho = () => hud.signedIn(api.claims()?.email
        ?? (api.userId() ? 'signed in' : null));
    ctx.attention = mountAttention(hud.waitingSlot(), attentionHooks(ctx));
    await mountShelves(ctx);
    if (!ctx.ground?.coverage) hud.show('Setup');
}

// UI.4–6: the Marketplace — Shop, Selling, Register (where you put your own
// on sale), Licences and Earnings. What you
// registered or got is in Build's Inventory (UI.3), where Place walks into
// build mode with the product picked and the camera frames it
// (client/js/buildframe.js).
async function mountShelves(ctx) {
    const { hud } = ctx;
    ctx.catalog = await mountMarketplace((name) => hud.panel(name), {
        onPublished: () => ctx.inventory.refresh(),
        show: (name) => hud.show(name),
    });
    for (const part of ['Shop', 'Selling', 'Register', 'Licences', 'Earnings']) {
        hud.whenShown(part, () => ctx.catalog.refresh());
    }
    ctx.inventory = mountInventory(hud.panel('Inventory'), {
        onPlace: (asset) => {
            hud.show('Place');
            ctx.build.toggle(true);
            ctx.build.setBrush(asset, { frame: true });
        },
        openMarket: () => hud.app('Marketplace'),
    });
    hud.whenShown('Inventory', () => ctx.inventory.refresh());
}

// SPEC §2.1 and §2.15: what is waiting for you, and one click to the thing.
function attentionHooks(ctx) {
    return {
        openPanel: (name) => ctx.hud.show(name),
        onChange: () => {
            ctx.assignLand.refresh();
            ctx.land.refresh();
            ctx.permission.refresh();
            // The ground under you can become yours while you stand still, so
            // the answer that was cached until you walked somewhere else is not
            // the answer any more.
            ctx.s.asked = { lon: 0, lat: 0, at: 0 };
        },
        onGo: (at) => {
            const p = ctx.origin.localOf({ lon: at.lon, lat: at.lat, h: 0 });
            ctx.player.position = { x: p.x, y: p.y + 2, z: p.z };
        },
    };
}
