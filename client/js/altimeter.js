// altimeter.js — how high you are, how far that is above the ground, and where
// you are looking. The design (docs/design/chrome5.dc.html) puts it on the
// right-hand edge, because height is the one number walking never tells you and
// flying is nothing but.
//
// A ladder of tick marks that slides past a fixed line: the line is always
// where you are, so the numbers move and you do not. The ground is drawn on the
// same ladder, which is what makes "16 m above ground" a picture rather than a
// figure.

// A tick every 30px, a number on every second one. How tall the ladder is
// comes from the stylesheet, so a short window shortens it without the
// arithmetic here having to know.
const DIV = 30;
const TALL = 300;
// The metres a division is worth. The smallest one that keeps the ground on
// the ladder is used, so standing on it reads in metres and flying over it in
// kilometres without either being a different instrument.
const STEPS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];

const el = (tag, props = {}, ...kids) => {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...kids.filter((k) => k !== null && k !== undefined));
    return node;
};

// The smallest division that keeps the ground within a third of the ladder:
// standing on it reads in metres, flying over it in kilometres, and neither
// asks the player to notice that the instrument changed.
export const stepFor = (agl) =>
    STEPS.find((s) => s * 3 >= Math.abs(agl ?? 0)) ?? STEPS.at(-1);

// Where the numbers sit. Pure arithmetic, so what the ladder says can be
// checked without a browser: `above` is null where nothing is known about the
// ground, and then the ladder is just a height.
export function ladderOf({ altitude, above = null, height = TALL }) {
    const step = stepFor(above ?? altitude);
    const ppm = DIV / step;
    const mid = height / 2;
    const first = Math.ceil((altitude - mid / ppm) / step) * step;
    const marks = [];
    for (let m = first; ; m += step) {
        const y = mid - (m - altitude) * ppm;
        if (y < 0) break;
        marks.push({ m, y, labelled: Math.round(m / step) % 2 === 0 });
    }
    const gy = above === null ? null : mid + above * ppm;
    return { step, ppm, mid, marks,
        ground: gy === null || gy < 0 || gy > height ? null : gy };
}

// A tick and its number are one node each, made once and moved after that: the
// ladder is redrawn on every frame the player moves, and a frame is 16 ms.
function ladderRungs(host, count) {
    const rungs = [];
    for (let i = 0; i < count; i++) {
        const line = el('i', { className: 'rung' });
        const text = el('span', { className: 'num' });
        host.append(line, text);
        rungs.push({ line, text });
    }
    return rungs;
}

// The instrument itself, made once: a readout, a ladder, and the pitch gutter
// down its right-hand edge.
function build() {
    const value = el('span', { className: 'v', textContent: '—' });
    const unit = el('span', { className: 'u', textContent: 'm' });
    const agl = el('span', { className: 'agl' });
    const rungHost = el('div', { className: 'rungs' });
    const ground = el('div', { className: 'gnd' }, el('span', { textContent: 'Gnd' }));
    const now = el('div', { className: 'now' });
    const arrow = el('i', { className: 'arrow' });
    const gutter = el('div', { className: 'gutter' }, el('i', { className: 'zero' }), arrow);
    const ladder = el('div', { className: 'ladder glass' },
        el('div', { className: 'hatch' }), rungHost, ground, now, gutter);
    const pitchNow = el('span', { className: 'cur' });
    const node = el('div', { id: 'alt' },
        el('div', { className: 'read' }, el('span', { className: 'v-row' }, value, unit), agl),
        el('div', { className: 'row' },
            el('span', { className: 'cap', textContent: 'Alt' }), ladder,
            el('div', { className: 'pitch' },
                el('span', { className: 'end', textContent: '+90°' }), pitchNow,
                el('span', { className: 'end', textContent: '−90°' }))));
    // Three more rungs than the ladder has divisions: whatever it is offset
    // by, both ends are covered.
    const rungs = ladderRungs(rungHost, Math.ceil(TALL / DIV) + 3);
    return { node, ladder, rungs, value, agl, ground, now, arrow, pitchNow };
}

export function mountAltimeter(parent) {
    const { node, ladder, rungs, value, agl, ground, now, arrow, pitchNow } = build();
    parent.append(node);
    let H = TALL;
    let last = null;
    if (typeof ResizeObserver === 'function') {
        new ResizeObserver(([e]) => {
            H = e.contentRect.height || TALL;
            last = null;                       // the ladder is a new shape
        }).observe(ladder);
    }
    return {
        node,
        // `above` is null where nothing is known about the ground under you —
        // off the edge of the world, or a tile whose heights have not loaded.
        set({ altitude, above = null, pitch = 0 }) {
            if (!Number.isFinite(altitude)) return;
            const deg = Math.max(-90, Math.min(90, pitch));
            const gnd = above === null ? 'x' : Math.round(above * 10);
            const key = `${Math.round(altitude * 10)}/${gnd}/${Math.round(deg)}`;
            if (key === last) return;
            last = key;
            value.textContent = Math.round(altitude).toLocaleString('en');
            agl.textContent = above === null ? 'ground unknown'
                : `${Math.round(above).toLocaleString('en')} m above ground`;
            const lad = ladderOf({ altitude, above, height: H });
            rungs.forEach(({ line, text }, i) => {
                const mark = lad.marks[i];
                line.style.display = mark ? '' : 'none';
                text.style.display = mark?.labelled ? '' : 'none';
                if (!mark) return;
                line.style.top = `${mark.y}px`;
                text.style.top = `${mark.y + 2}px`;
                if (mark.labelled) text.textContent = mark.m.toLocaleString('en');
            });
            ground.style.display = lad.ground === null ? 'none' : '';
            if (lad.ground !== null) ground.style.top = `${lad.ground}px`;
            now.style.top = `${lad.mid}px`;
            // The pitch gutter runs the whole ladder: straight up at the top,
            // straight down at the bottom, and the number beside it.
            const py = (0.5 - deg / 180) * H;
            arrow.style.top = `${py}px`;
            pitchNow.style.top = `${py}px`;
            const sign = deg > 0 ? '+' : deg < 0 ? '\u2212' : '';
            pitchNow.textContent = `${sign}${Math.abs(Math.round(deg))}°`;
        },
    };
}
