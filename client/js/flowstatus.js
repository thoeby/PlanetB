// flowstatus.js — what floats over the Automate canvas (design 10a): the named
// nets and the zoom at the top right, and at the bottom left how many blocks
// and wires the flow has and how many of them the chosen server does not know.

import { el } from './poolui.js';

const count = (n, word) => [el('b', { textContent: String(n) }), ` ${word}`];

export function mountStatus(canvas, { server, showNets }) {
    const nets = el('button', { type: 'button', className: 'fl-chip fl-nets-chip' });
    nets.onclick = () => showNets?.();
    const zoom = el('button', { type: 'button', className: 'fl-chip fl-zoom',
        title: 'Back to 100%' });
    zoom.onclick = () => {
        canvas.view.ds.scale = 1;
        canvas.graph.setDirtyCanvas(true, true);
        draw();
    };
    const blocks = el('span');
    const wires = el('span');
    const missing = el('span', { className: 'fl-status-missing' });
    const bar = el('div', { className: 'fl-status' }, blocks, wires, missing);
    // Design 10b: a process opened from a server says whose bytes these are.
    const banner = el('div', { className: 'fl-ro-banner', hidden: true });
    canvas.wrap.append(banner, el('div', { className: 'fl-chips' }, nets, zoom), bar);

    function draw() {
        const nodes = (canvas.graph._nodes ?? []).filter((n) => n._irKind === 'node');
        const links = Object.keys(canvas.graph.links ?? {}).length;
        const gone = nodes.filter((n) => n._irMissingOn || n._irPlaceholder).length;
        blocks.replaceChildren(...count(nodes.length, nodes.length === 1 ? 'block' : 'blocks'));
        wires.replaceChildren(...count(links, links === 1 ? 'wire' : 'wires'));
        const name = server()?.name;
        missing.textContent = gone && name
            ? `${gone} block${gone === 1 ? '' : 's'} ${name} does not know` : '';
        missing.hidden = !missing.textContent;
        nets.replaceChildren('Nets', el('small', { textContent: String(canvas.nets().length) }));
        zoom.textContent = `${Math.round((canvas.view.ds?.scale ?? 1) * 100)}%`;
    }
    canvas.wrap.addEventListener('wheel', () => requestAnimationFrame(draw), { passive: true });
    return {
        draw,
        readOnly(name) {
            banner.textContent = name ? `Read-only \u00b7 the bytes as ${name} has them` : '';
            banner.hidden = !name;
        },
    };
}
