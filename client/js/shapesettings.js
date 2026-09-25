// shapesettings.js — the operator's say over shaping, in Settings · Setup
// (EDT.7 and EDT.10): how far above and below the elevation a land's ground
// may be moved (SPEC §6), and whether a brush fades out at a land's edge.
//
// They are app settings (db/0156): an admin sets them, everybody's tab reads
// them. The page only asks; set_app_setting refuses anybody but an admin
// (Invariant 6).

import * as api from './api.js';
import { el } from './tabbar.js';

export const DEFAULTS = { shape_max_up: '8', shape_max_down: '8', edge_blend: 'on' };

export function mountShapeSettings(host) {
    const up = el('input', { type: 'number', className: 'ss-up', min: '0', step: '0.5' });
    const down = el('input', { type: 'number', className: 'ss-down', min: '0', step: '0.5' });
    const blend = el('input', { type: 'checkbox', className: 'ss-blend' });
    const said = el('p', { className: 'muted ss-said' });
    const save = el('button', { type: 'button', className: 'ss-save', textContent: 'Save' });
    const node = el('div', { className: 'section ss-shaping', hidden: true },
        el('div', { className: 'label', textContent: 'Shaping the ground' }),
        el('label', {}, 'Most metres up from the elevation', up),
        el('label', {}, 'Most metres down', down),
        el('label', {}, blend, ' A brush fades out over the last 4 m of a land'),
        save, said);
    host.append(node);
    const read = async () => {
        node.hidden = api.role() !== 'admin';
        if (node.hidden) return;
        const set = { ...DEFAULTS, ...(await api.rpc('app_settings').catch(() => ({}))) };
        up.value = set.shape_max_up;
        down.value = set.shape_max_down;
        blend.checked = set.edge_blend !== 'off';
    };
    save.onclick = async () => {
        try {
            await api.rpc('set_app_setting', { key: 'shape_max_up', value: String(up.value) });
            await api.rpc('set_app_setting', { key: 'shape_max_down', value: String(down.value) });
            await api.rpc('set_app_setting', { key: 'edge_blend',
                value: blend.checked ? 'on' : 'off' });
            said.textContent = 'saved — a land opened in Shape from now on keeps to it';
        } catch (err) {
            said.textContent = String(err.body?.message ?? err.message ?? err);
        }
    };
    read();
    setInterval(() => { if (node.hidden === (api.role() === 'admin')) read(); }, 5000);
    return { node, read };
}
