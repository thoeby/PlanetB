// visit.js — the address bar is a place (TASKS-usable T8).
//
// A link carries where you are standing and which way you are facing, so
// sending one is how you show somebody something. Nothing else in the page
// needs to know: play.html asks parseVisit() once on load, keeps the address
// bar current as you walk, and the Share panel hands the link over.
//
// The order in the link is latitude, longitude, height — what people paste out
// of a map — and the heading in degrees from north.

const NUM = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };

// "#at=47.3801,8.5500,412,135" -> { lat, lon, h, heading }. Anything that is
// not four readable numbers is not a place, and the page opens where it would
// have opened anyway.
export function parseVisit(href) {
    const hash = String(href).split('#')[1] ?? '';
    const raw = new URLSearchParams(hash).get('at');
    if (!raw) return null;
    const [lat, lon, h, heading] = raw.split(',').map(NUM);
    if (lat === null || lon === null || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
        return null;
    }
    return { lat, lon, h: h ?? 0, heading: heading ?? 0 };
}

export const visitHash = ({ lat, lon, h = 0, heading = 0 }) =>
    `#at=${lat.toFixed(5)},${lon.toFixed(5)},${Math.round(h)},${Math.round(heading)}`;

// The whole link, with whatever the page was opened from as its base.
export const visitLink = (href, where) =>
    String(href).split('#')[0] + visitHash(where);

// No line of its own about what the link is: the tab already says it
// (client/js/hud.js), and saying it twice is how a panel stops being read.
const SHARE_HTML = `
<input class="sh-link" type="text" readonly>
<div class="row">
  <button type="button" class="sh-copy primary">Copy link</button>
</div>
<p class="sh-status status"></p>`;

const el = (tag, props = {}) => Object.assign(document.createElement(tag), props);

// Clipboard first; a browser that refuses it still leaves the link selected,
// which is one keystroke from the same thing.
async function copy(input, say) {
    input.select();
    try {
        await navigator.clipboard.writeText(input.value);
        say('copied — paste it to somebody');
    } catch {
        say('press ctrl-C: this browser does not let a page write the clipboard');
    }
}

// The same, for a link nobody is looking at: the copy is offered through an
// input so a browser that refuses the clipboard still leaves it selected.
export async function copyLink(doc, text) {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch {
        const input = doc.body.appendChild(el('input', { value: text }));
        input.select();
        const ok = doc.execCommand?.('copy') ?? false;
        input.remove();
        return ok;
    }
}

export function mountShare(host, { where, href = () => globalThis.location.href } = {}) {
    const box = el('div');
    box.innerHTML = SHARE_HTML;
    host.append(box);
    const q = (sel) => box.querySelector(sel);
    const say = (msg) => { q('.sh-status').textContent = msg; };

    function refresh() {
        const here = where();
        if (!here) return '';
        q('.sh-link').value = visitLink(href(), here);
        return q('.sh-link').value;
    }

    q('.sh-copy').onclick = () => { refresh(); copy(q('.sh-link'), say); };
    refresh();
    return { refresh, link: () => q('.sh-link').value };
}
