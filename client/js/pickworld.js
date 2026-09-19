// pickworld.js — "Pick in world" (FND.14): Automate steps aside, the 3D view
// asks for a click, and what was clicked goes back into the flow.
//
// A World block names an object by its id. Nobody types a uuid, and a list of
// products on a land is not how anybody knows which lamp they mean — the lamp
// they mean is the one they can see. So the view the player is standing in is
// the picker, and build mode's own ray (client/js/buildui.js) is what says
// what is under the pointer.

import { el } from './poolui.js';

export function mountPickWorld(host, { canvas, pick, before, after }) {
    const line = el('p', { className: 'pick-line' });
    const stop = el('button', { type: 'button', className: 'pick-stop',
        textContent: 'Never mind' });
    const box = el('div', { id: 'pick-ask', className: 'glass' }, line, stop);
    box.hidden = true;
    host.append(box);

    function ask(where) {
        line.textContent = `click an object on ${where}`;
        box.hidden = false;
        before?.();
        return new Promise((resolve) => {
            const done = (row) => {
                canvas.removeEventListener('click', onClick);
                box.hidden = true;
                after?.();
                resolve(row ?? null);
            };
            const onClick = async (e) => {
                const r = canvas.getBoundingClientRect();
                const row = await pick({ x: e.clientX - r.left, y: e.clientY - r.top });
                if (row) done(row);
            };
            stop.onclick = () => done(null);
            canvas.addEventListener('click', onClick);
        });
    }

    return { node: box, ask, asking: () => !box.hidden };
}
