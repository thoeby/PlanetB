// hudframe.js — the panel's frame and the two drawers off the top bar, split
// out of hud.js when it passed the four hundred lines CLAUDE.md allows.

import { TABS } from './tabbar.js';
import { el } from './chrome.js';

// The panel frame: a title, whatever this surface says about itself above its
// parts, the parts where it has more than one, and the × that closes it.
export function panelFrame(onClose, onPart) {
    const title = el('span', { className: 'title' });
    const close = el('button', { type: 'button', className: 'close',
        textContent: '×', title: 'close' });
    close.onclick = onClose;
    // One host per surface, between the title and the parts: what is true of
    // every part of a surface belongs above the tabs rather than repeated
    // inside each of them. Work's machine strip is the case — what this tab
    // can do and what it is doing is the same answer whichever queue you are
    // looking at.
    const heads = new Map();
    const head = el('div', { className: 'head' });
    for (const t of TABS) {
        const host = el('div', { className: 'tab-head' });
        host.hidden = true;
        heads.set(t.name, host);
        head.append(host);
    }
    const parts = el('nav', { className: 'parts' });
    const partButtons = new Map();
    for (const t of TABS) {
        for (const part of t.parts ?? []) {
            const b = el('button', { type: 'button', className: 'part',
                textContent: part.label });
            b.dataset.tab = part.name;
            b.dataset.of = t.name;
            b.setAttribute('aria-selected', 'false');
            // A part that cannot be used yet says why, and is not pressed.
            if (part.off) { b.disabled = true; b.title = part.off; }
            b.onclick = () => onPart(part.name);
            partButtons.set(part.name, b);
            parts.append(b);
        }
    }
    const body = el('div', { className: 'body' });
    const node = el('aside', { id: 'panel', className: 'glass' },
        el('header', {}, title, close), head, parts, body);
    return { node, title, body, head, heads, parts, partButtons };
}

// The drawer and the tray are the two things that hang off the top strip, and
// only one of them is ever down.
export function drawersOf(at) {
    const d = {
        apps(yes) {
            at().drawer.node.hidden = !yes;
            at().strip.appsBtn.setAttribute('aria-selected', String(yes));
            if (yes) d.tray(false);
        },
        tray(yes) {
            at().notify.open(yes);
            at().strip.bell.setAttribute('aria-selected', String(yes));
            if (yes) {
                at().drawer.node.hidden = true;
                at().strip.appsBtn.setAttribute('aria-selected', 'false');
            }
        },
        toggleTray() { d.tray(!at().notify.isOpen()); },
        close() {
            const was = !at().drawer.node.hidden || at().notify.isOpen();
            d.apps(false);
            d.tray(false);
            return was;
        },
    };
    return d;
}

// Whoever is drawing the world is told when a workspace takes it over, because
// a world nobody can see is a world nobody should be rendering. Once, when it
// changes, rather than on every panel that opens.
export function windowWatch(f, taking) {
    let held = '';
    return () => {
        if (f.hud.dataset.window === held) return;
        held = f.hud.dataset.window;
        for (const fn of taking) fn(held === '1');
    };
}

