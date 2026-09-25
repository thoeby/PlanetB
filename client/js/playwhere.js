// playwhere.js — where the player is: links in and out, the address bar, and
// the land under their feet (play.js).

import { sameSpot } from './places.js';
import { nearestGround, parseVisit, visitHash } from './visit.js';

// How long the page leaves the address bar alone after being handed one.
const HANDED_OVER_MS = 3000;

export function mountWhere(ctx) {
    ctx.s.stampAfter = 0;
    // Something about arriving somewhere, which stands for a while and then
    // gives the line back to whatever the world is missing.
    ctx.s.arrival = { text: '', until: 0 };
    ctx.arriving = (text) => {
        ctx.s.arrival = { text, until: Date.now() + 20000 };
        ctx.hud.notice(text);
    };
    ctx.goTo = (to) => goTo(ctx, to);
    const arrivedAt = parseVisit(location.href);
    if (arrivedAt) ctx.goTo(arrivedAt);
    // T8: a link is a place, and pasting one into the tab you already have open
    // is the same link. Without this it only worked on a fresh load, because
    // changing the hash does not reload anything.
    window.addEventListener('hashchange', () => {
        const to = parseVisit(location.href);
        if (to) ctx.goTo(to);
    });
    ctx.s.lands = '';
    ctx.s.landStale = false;
}

// T8: a link is a place. Somebody sent this address because of what is at
// that spot, so the page opens there rather than wherever the anchor is.
// SPEC §3.8: a link outside the coverage arrives at the nearest ground and
// says so, rather than at a place with no ground, no tile and nothing to see
// — which looks like a broken page rather than a link to nowhere.
function goTo(ctx, { lat, lon, h = 0, heading }) {
    // Somebody has just said where to be. Stop writing over the address bar
    // for a moment: pasting a link into a tab that is already open changes
    // the hash, and the browser delivers that change a tick later — long
    // enough for this page to have replaced it with where the player still
    // is, which is how a pasted link went nowhere at all.
    ctx.s.stampAfter = Date.now() + HANDED_OVER_MS;
    const at = nearestGround({ lon, lat }, ctx.ground);
    if (at.moved) ctx.arriving('that place is off the edge of the world');
    const q = ctx.origin.localOf({ lon: at.lon, lat: at.lat, h });
    const under = ctx.terrain.heightAt(q);
    ctx.player.position = { x: q.x, y: (under ?? q.y) + 2, z: q.z };
    if (Number.isFinite(heading)) ctx.player.heading = heading;
}

// …or when the land itself changes under them. Giving a piece of land back
// (story 11) leaves you standing exactly where you were, so nothing about the
// camera says the answer is stale — but the line under you was naming land
// that no longer exists.
export function landChanged(ctx, areas) {
    const now = (areas ?? []).map((a) => a.id).sort().join(',');
    if (now === ctx.s.lands) return;
    ctx.s.lands = now;
    ctx.s.landStale = true;
}

// The address bar says where you are, so copying it out of the browser is the
// same as the Share panel's button. Twice a second at most: it is a string,
// but replaceState on every frame is not free and fills nothing useful.
export function keepTheAddressBar(ctx, where) {
    // A world with no ground has no places in it; a link to one is a link to
    // nowhere.
    if (!ctx.ground?.coverage) return;
    if (Date.now() < ctx.s.stampAfter) return;
    ctx.s.stampAfter = Date.now() + 2000;
    window.history.replaceState(null, '', visitHash(where));
    ctx.share.refresh();
}

// The land under the player, and whether they may build on it. area_at is a
// spatial question no filter can ask, so it is asked when the ground changes
// rather than every frame.
export function whereAmI(ctx, g) {
    const { s, ground, hud } = ctx;
    // Asked again when the player has walked somewhere else or the land itself
    // changed — and, either way, at least every few seconds. An answer can be
    // thrown away (a newer question was already in the air) or never arrive,
    // and a line that is only re-asked when the camera moves then keeps the
    // wrong name under somebody who is standing still.
    const moved = !sameSpot(g, s.asked);
    const fresh = moved || s.landStale;
    if (Date.now() - s.asked.at < (fresh ? 2000 : 5000)) return;
    s.landStale = false;
    s.asked = { lon: g.lon, lat: g.lat, at: Date.now() };
    // Outside the coverage there is no world at all, which is a different
    // thing from ground nobody has claimed (T1).
    if (ground?.coverage && (g.lon < ground.west || g.lon > ground.east
        || g.lat < ground.south || g.lat > ground.north)) {
        hud.standing({ land: 'off the edge of the world', owner: '',
            right: `outside ${ground.coverage}`, may: false });
        return;
    }
    // The Place panel answers "may I build here"; the answer changes when you
    // walk somewhere else — not when this is only the periodic re-ask, which
    // is several requests for an answer nothing has changed.
    if (fresh) ctx.build.refresh();
    askAreaAt(ctx, g);
}

// Where this answer is about. Two questions are in the air whenever the player
// is still arriving somewhere, and the older one landing last put the wrong
// land's name under them — so an answer is used only while the player is still
// where it was asked about. Not the question's identity: the periodic re-ask
// asks about the same spot, and under load the answers were taking longer than
// the interval, so every one of them was thrown away by the next and the line
// never changed at all.
function askAreaAt(ctx, g) {
    const { hud } = ctx;
    const mine = { lon: g.lon, lat: g.lat };
    ctx.api.rpc('area_at', { lon: g.lon, lat: g.lat }).then((areas) => {
        if (!sameSpot(ctx.s.asked, mine)) return;
        const a = areas?.[0];
        // SPEC §2.4: the land you are standing on has a card whoever's it is,
        // and §3.11 is asked for from that card.
        ctx.land.standingOn(a ?? null);
        if (!a) {
            hud.standing({ land: 'unclaimed ground', owner: '',
                right: 'nobody owns this', may: false });
            return;
        }
        hud.standing({
            land: a.name || 'unnamed land',
            owner: a.mine ? 'you' : (a.owner ?? ''),
            right: a.may_write ? 'you may build here'
                : a.may_propose ? 'you may propose here' : 'read only',
            may: Boolean(a.may_write),
        });
    }).catch(() => { ctx.s.landStale = true; });
}
