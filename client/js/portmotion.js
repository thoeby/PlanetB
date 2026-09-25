// portmotion.js — the Ports section's fields for a part that moves (LV.1).
//
// A joint is told a pose, a path or a spin (db/0200). Each gets the few
// fields that say it and one button that sends it; the world records the
// clock of the write, and every tab moves the part from there.

import { el } from './poolui.js';

const numberField = (cls, value, step = 'any') => el('input', {
    type: 'number', className: cls, value: String(value), step });

const labelled = (text, input) => el('label', { className: 'pm-field' }, `${text} `, input);

// "x,y,z; x,y,z" — the way a person types a line of points.
export function readRoute(text) {
    return String(text ?? '').split(';').map((p) => p.trim()).filter(Boolean)
        .map((p) => p.split(',').map((n) => Number(n.trim())));
}

function pose(set) {
    const keys = ['x', 'y', 'z', 'yaw', 'pitch', 'roll', 'scale'];
    const inputs = Object.fromEntries(keys.map((k) =>
        [k, numberField(`pm-${k}`, '')]));
    const over = numberField('pm-over', 2);
    const go = el('button', { type: 'button', className: 'pm-go', textContent: 'Move' });
    go.onclick = () => {
        const to = {};
        for (const k of keys) {
            if (inputs[k].value !== '') to[k] = Number(inputs[k].value);
        }
        set({ to, over_s: Number(over.value) || 0 });
    };
    return el('div', { className: 'pm-pose' },
        ...keys.map((k) => labelled(k, inputs[k])), labelled('over s', over), go);
}

function path(set) {
    const route = el('input', { type: 'text', className: 'pm-route',
        placeholder: '0,0,0; 10,0,0' });
    const speed = numberField('pm-speed', 1);
    const loop = el('input', { type: 'checkbox', className: 'pm-loop' });
    const go = el('button', { type: 'button', className: 'pm-go', textContent: 'Follow' });
    go.onclick = () => set({ route_m: readRoute(route.value),
        speed: Number(speed.value) || 0, loop: loop.checked });
    return el('div', { className: 'pm-path' }, labelled('route m', route),
        labelled('m/s', speed), labelled('loop', loop), go);
}

function spin(set) {
    const axis = el('select', { className: 'pm-axis' });
    axis.append(...['y', 'x', 'z'].map((a) => new Option(a, a)));
    const rpm = numberField('pm-rpm', 6);
    const go = el('button', { type: 'button', className: 'pm-go', textContent: 'Spin' });
    go.onclick = () => set({ axis: axis.value, rpm: Number(rpm.value) || 0 });
    return el('div', { className: 'pm-spin' }, labelled('axis', axis),
        labelled('rpm', rpm), go);
}

export function motionField(port, set) {
    if (port.type === 'pose') return pose(set);
    if (port.type === 'path') return path(set);
    return spin(set);
}
