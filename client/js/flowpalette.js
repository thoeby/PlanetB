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
        group: source.from(b.plugin) ? `${path(b)} \u00b7 ${source.from(b.plugin)}`
            : path(b),
        from: source.from(b.plugin),
        label: b.name || b.id,
        hay: `${b.name} ${b.id} ${path(b)}`.toLowerCase().replaceAll(/[-_.]/g, ' '),
    })).sort((a, b) => a.block.plugin.localeCompare(b.block.plugin)
        || a.label.localeCompare(b.label));
}

const needle = (text) => text.toLowerCase().replaceAll(/[-_.]/g, ' ').trim();

export function matching(all, text) {
    const want = needle(text);
    if (!want) return all;
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

const REFRESH = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 1 0'
    + '-2.3 5.7"/><path d="M20 4v7h-7"/></svg>';

// One line: a diamond, the name, and the plugin it belongs to. Where the chosen
// server gave it, the line says so too, for anyone not reading the heading.
function drawLine(line, host, onDrop) {
    const li = el('li', { draggable: true, title: line.group },
        el('i', { className: 'fl-dia' }),
        el('span', { className: 'fl-bname', textContent: line.label }),
        el('span', { className: 'group', textContent: line.block.plugin }),
        line.from ? el('span', { className: 'fl-sr', textContent: ` \u00b7 ${line.from}` })
            : '');
    li.dataset.block = `${line.block.plugin}.${line.block.id}`;
    li.dataset.world = line.block.plugin === 'world' ? '1' : '';
    li.ondragstart = (e) => {
        e.dataTransfer.setData('text/plain', li.dataset.block);
        e.dataTransfer.effectAllowed = 'copy';
    };
    // A double-click drops it in the middle, for anyone not dragging.
    li.ondblclick = () => onDrop(line.block, null);
    carry(li, line.block, host, onDrop);
    return li;
}

// Design 10a: the blocks under a heading per plugin, the plugin's source at
// the heading's right.
function drawGroups(list, found, host, onDrop) {
    let plugin = null;
    let ul = null;
    for (const line of found) {
        if (line.block.plugin !== plugin) {
            plugin = line.block.plugin;
            const world = plugin === 'world';
            const name = world && line.from ? `World \u2014 ${line.from}` : plugin;
            const from = world ? '' : line.from;
            ul = el('ul');
            list.append(el('div', { className: 'fl-pgroup' },
                el('div', { className: 'fl-phead' },
                    el('span', { textContent: name }),
                    el('span', { className: 'fl-from', textContent: from })), ul));
        }
        ul.append(drawLine(line, host, onDrop));
    }
}

// The list, and the drag.
export function mountPalette(host, { onDrop, onRefresh }) {
    const search = el('input', { type: 'search', placeholder: 'search blocks',
        className: 'fl-search' });
    search.setAttribute('aria-label', 'Search blocks');
    const again = el('button', { type: 'button', className: 'fl-blocks-again fl-icon',
        title: 'Ask the process server for its blocks again' });
    again.setAttribute('aria-label', 'Refresh blocks');
    again.innerHTML = REFRESH;
    again.onclick = () => onRefresh?.();
    again.hidden = !onRefresh;
    const list = el('div', { className: 'fl-plist' });
    const node = el('div', { className: 'fl-palette' },
        el('div', { className: 'fl-palette-head' },
            el('h2', { textContent: 'Blocks' }), again),
        el('label', { className: 'fl-searchbox' }, search), list,
        el('p', { className: 'fl-pfoot', textContent: 'Drag onto the canvas.' }));
    host.append(node);

    let all = [];
    let source = ALL;
    const draw = () => {
        list.replaceChildren();
        const found = matching(all, search.value);
        if (!found.length) {
            list.append(el('ul', {}, el('li', { className: 'muted',
                textContent: 'No block of that name.' })));
            return;
        }
        drawGroups(list, found, node, onDrop);
    };
    search.oninput = draw;
    return {
        node,
        // Called once the plugins are registered, and again if they change.
        refresh(next = source) {
            source = next;
            if (source.server) again.title = `Ask ${source.server} for its blocks again`;
            all = lines(source);
            draw();
        },
        blockOf(key) { return all.find((l) => `${l.block.plugin}.${l.block.id}` === key)?.block; },
        focus() { search.focus(); },
        search,
    };
}
