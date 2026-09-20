// hudsays.js — the sentences the chrome says about you and about the world,
// and the one control surface the rest of the page writes through.
//
// Split out of client/js/hud.js when that file passed the four hundred lines
// CLAUDE.md allows. It holds no nodes of its own: `state` is handed the frame
// hud.js built and writes into it.

import { drawHints, el } from './chrome.js';
import { surfaceOf } from './tabbar.js';

// An empty world is black, and black says nothing. What is missing is always
// one of four things, and each of them is somebody's next move.
export function whatIsMissing({ coverage, areas = 0, mine = 0, things = null,
    published = 0 } = {}) {
    if (!coverage) {
        return 'No ground yet. Setup \u00b7 connect your GeoServer and pick the'
            + ' coverage the world stands on.';
    }
    if (!areas) {
        return 'No land yet. Draw an area in QGIS — run `splatworld qgis`, open'
            + ' gis/splatworld.qgs, draw on Your land and save.';
    }
    // Land on its own holds nothing to compile: a tile exists where something
    // stands. This is the step people fall down, because the land is drawn and
    // the world still says nothing is waiting.
    if (things === 0) {
        return 'Nothing stands on your land yet. In QGIS, draw a road, a wood or'
            + ' a building inside it and save — that is what there is to compile.';
    }
    if (!published) {
        return mine
            ? 'Nothing here is compiled yet. Submit \u00b7 put your land in the'
              + ' render pool, then render it and approve what comes back.'
            : 'Nothing here is compiled yet, and none of the land is yours.';
    }
    return '';
}

// Two letters off a name or an address, for the face on the bar.
const initials = (label) => {
    const word = String(label ?? '').split('@')[0];
    const parts = word.split(/[^A-Za-z0-9]+/).filter(Boolean);
    const two = parts.length > 1 ? parts[0][0] + parts[1][0] : word.slice(0, 2);
    return (two || '\u2014').toUpperCase();
};

// What the bar and the corners say about you and about the world's progress.
export function state(f) {
    const { you, stats, buttons, notice } = f;
    const credits = f.strip.money.credits;
    return {
        // A surface with something waiting behind it says so without being
        // opened. A count hung on a part shows on the surface that holds it.
        badge(name, n) {
            const b = buttons.get(surfaceOf(name)?.tab ?? name);
            if (!b) return;
            b.querySelector('.count')?.remove();
            if (n > 0) b.append(el('span', { className: 'count', textContent: String(n) }));
        },
        // How many jobs are behind one part of a surface, on the part's own
        // tab (design 8a: every queue carries its count). A null takes it off;
        // zero is a number worth showing, because an empty queue is an answer.
        partCount(name, n) {
            const b = f.frame.partButtons.get(name);
            if (!b) return;
            b.querySelector('.count')?.remove();
            if (n !== null && n !== undefined) {
                b.append(el('span', { className: 'count', textContent: String(n) }));
            }
        },
        // What this machine is computing, on the strip along the top rather
        // than inside the panel that is about it (client/js/topbar.js). Empty
        // text takes the chip away, which is what idle looks like.
        machine(text, tone = '') {
            const chip = f.strip.machine;
            chip.b.hidden = !text;
            chip.b.dataset.doing = tone;
            chip.what.textContent = text ?? '';
        },
        // Who you are, on the chip that is you: initials on the face, the name
        // beside it, and a lit pip when somebody is signed in at all.
        signedIn(label) {
            const name = label && label !== 'not signed in' ? label : '';
            // The chip is 9rem wide: an address is shown by the part of it
            // that is a person, with the whole of it on the button's title.
            you.name.textContent = name ? name.split('@')[0] : 'Sign in';
            you.face.textContent = initials(name);
            you.b.dataset.in = name ? '1' : '';
            you.b.title = name || 'Profile';
        },
        // The one line an empty world needs: what is missing, and where to do
        // something about it. Empty text takes it away.
        notice(text) {
            notice.textContent = text ?? '';
            notice.hidden = !text;
        },
        // v6 keeps two of the five stages on the bar — what is rendered and
        // what is waiting for a person — and the balance beside them. The rest
        // are read in the panel that is about them; a number nobody acts on is
        // not worth a strip along the top.
        stat(key, value) {
            if (key === 'credits') {
                credits.replaceChildren(value ?? '\u2014', el('i', { textContent: 'CR' }));
            } else if (stats[key]) stats[key].textContent = value;
        },
        // How high you are, how far that is above the ground, and where you
        // are looking (client/js/altimeter.js).
        height(at) { f.alt.set(at); },
        // Walking or flying, and the keys for it (SPEC §2.3's corner).
        moving(mode) { drawHints(f.hints, mode); },
        // The minimap, the scale it is drawn at, and where its search lives.
        minimap: () => f.map,
        mapBox: () => f.mapBox,
        mapScale(text) { f.scale.textContent = text; },
        // Where the attention chip is mounted (SPEC §2.1).
        waitingSlot: () => f.waiting,
    };
}
