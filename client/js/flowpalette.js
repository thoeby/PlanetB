// flowpalette.js — the blocks there are, as a list you type into.
//
// SPEC §2.16: the palette is searched, not browsed. Every registered block is
// one line — its name and where it comes from — and dragging a line onto the
// canvas puts that block there. The groups come from the plugin XML, so the
// list reads the way the process server's own documentation does.

import { el } from './poolui.js';
import { allBlocks } from '../flow/plugins/registry.js';

const path = (b) => [b.plugin, ...b.groupPath].join('/');

// The whole set, once: a block's line is matched on its name, its id and the
// group path, so "from string" and "strings/from" both find the same thing.
// `source` (FL.2, flowblocks.js) says which plugins are offered here and which
// came from the chosen process server rather than the bundle.
const ALL = { visible: () => true, from: () => '' };

function lines(source = ALL) {
    return allBlocks().filter((b) => source.visible(b.plugin)).map((b) => ({
        block: b,
        group: source.from(b.plugin) ? `${path(b)} \u00b7 from ${source.from(b.plugin)}`
            : path(b),
        label: b.name || b.id,
        hay: `${b.name} ${b.id} ${path(b)}`.toLowerCase().replaceAll(/[-_.]/g, ' '),
    })).sort((a, b) => a.label.localeCompare(b.label));
}

const needle = (text) => text.toLowerCase().replaceAll(/[-_.]/g, ' ').trim();

export function matching(all, text) {
    const want = needle(text);
    if (!want) return all.slice(0, 40);
    const words = want.split(/\s+/);
    return all.filter((l) => words.every((w) => l.hay.includes(w))).slice(0, 40);
}

// Dragging a line onto the canvas, by the pointer rather than by the browser's
// own drag-and-drop. litegraph draws into a canvas and has no drop target of
// its own, so the gesture is the plain one: press on a line, let go over the
// canvas, and the block is put where the pointer was. The HTML5 drag is kept
// as well (flowcanvas.js handles the drop), for anyone whose habit that is.
function carry(li, block, host, onDrop) {
    li.onpointerdown = (down) => {
        if (down.button !== 0) return;
        down.preventDefault();
        const drop = (up) => {
            document.removeEventListener('pointerup', drop, true);
            host.dataset.carrying = '';
            const under = document.elementFromPoint(up.clientX, up.clientY);
            if (!under?.closest('.fl-canvas-wrap')) return;
            // A press and release in the same place is a click on the line,
            // not a drag across the canvas.
            if (Math.hypot(up.clientX - down.clientX, up.clientY - down.clientY) < 4) return;
            onDrop(block, { clientX: up.clientX, clientY: up.clientY });
        };
        host.dataset.carrying = '1';
        document.addEventListener('pointerup', drop, true);
    };
}

// The list, and the drag.
export function mountPalette(host, { onDrop, onRefresh }) {
    const search = el('input', { type: 'search', placeholder: 'Search blocks…',
        className: 'fl-search' });
    const again = el('button', { type: 'button', className: 'fl-blocks-again',
        textContent: 'Refresh blocks', title: 'Ask the process server for its blocks again' });
    again.onclick = () => onRefresh?.();
    again.hidden = !onRefresh;
    const list = el('ul');
    const node = el('div', { className: 'fl-palette' },
        el('div', { className: 'fl-palette-head' }, search, again), list);
    host.append(node);

    let all = [];
    let source = ALL;
    const draw = () => {
        list.replaceChildren();
        const found = matching(all, search.value);
        if (!found.length) {
            list.append(el('li', { className: 'muted',
                textContent: 'No block of that name.' }));
            return;
        }
        for (const line of found) {
            const li = el('li', { draggable: true, title: line.group },
                el('span', { textContent: line.label }), ' ',
                el('span', { className: 'group', textContent: line.group }));
            li.dataset.block = `${line.block.plugin}.${line.block.id}`;
            li.ondragstart = (e) => {
                e.dataTransfer.setData('text/plain', li.dataset.block);
                e.dataTransfer.effectAllowed = 'copy';
            };
            // A double-click drops it in the middle, for anyone not dragging.
            li.ondblclick = () => onDrop(line.block, null);
            carry(li, line.block, node, onDrop);
            list.append(li);
        }
    };
    search.oninput = draw;

    return {
        node,
        // Called once the plugins are registered, and again if they change.
        refresh(next = source) { source = next; all = lines(source); draw(); },
        blockOf(key) { return all.find((l) => `${l.block.plugin}.${l.block.id}` === key)?.block; },
        focus() { search.focus(); },
        search,
    };
}
