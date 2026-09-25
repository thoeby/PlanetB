// bpside.js — Blueprint's own card, in the corner where the walking keys are
// the rest of the time (docs/design/splatworld-v11.dc.html 11a): which keys
// move the clay camera, the overlays (client/js/bpoverlay.js), and the two
// view buttons. The walking keys and the altimeter are about the player's
// eyes, and while Blueprint is open the camera is not the player's.

import { overlayCard } from './bpoverlay.js';
import { el } from './tabbar.js';

const KEYS = [
    ['wheel', 'Zoom to the pointer'],
    ['right-drag', 'Orbit'],
    ['H', 'Hand: drag the land'],
    ['C', 'Section: drag a line'],
    ['O', 'Ortho / perspective'],
    ['Tab', 'Hold to peek at the splats'],
];

export function mountBlueprintSide(host, { bp, cam }) {
    const ortho = el('button', { type: 'button', className: 'bp-ortho', textContent: 'Ortho · O' });
    const fit = el('button', { type: 'button', className: 'bp-fit', textContent: 'Zoom to land' });
    fit.onclick = () => cam.toLand();
    ortho.onclick = () => { cam.setOrtho(!cam.state.ortho); show(); };
    const name = el('span', { className: 'bp-land muted' });
    const node = el('div', { id: 'bp-side', className: 'glass', hidden: true },
        el('div', { className: 'bp-head' },
            el('span', { className: 'bp-title caps', textContent: 'Blueprint' }), name),
        el('div', { className: 'bp-keys' }, ...KEYS.flatMap(([k, words]) => [
            el('kbd', { textContent: k }), el('span', { textContent: words })])),
        overlayCard(bp),
        el('div', { className: 'bp-view' }, fit, ortho));
    const corner = host.querySelector('#corner');
    if (corner) corner.prepend(node); else host.append(node);
    const show = () => {
        node.hidden = !bp.active;
        host.dataset.blueprint = bp.active ? '1' : '';
        name.textContent = bp.area?.rules?.name ?? '';
        ortho.setAttribute('aria-pressed', String(Boolean(cam.state.ortho)));
    };
    bp.onChange(show);
    return { node, show };
}
