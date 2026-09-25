// updatesui.js — a thing's version, and an update waiting on its owner (LV.9).
//
// A product's flow says what it needs (db/0210); a thing runs no more than its
// owner said yes to. When the product moves to a version that asks for more,
// the thing stays where it is and this says so, with **Allow**.

import * as api from './api.js';
import { el } from './poolui.js';

export const HTML = `
<div class="section build-update-section" hidden>
  <span class="label">Version</span>
  <p class="build-update note"></p>
  <div class="build-update-acts row"></div>
  <p class="build-update-said status"></p>
</div>`;

const short = (sha) => (sha ? sha.slice(0, 12) : 'none');

export function mountUpdates(host) {
    host.insertAdjacentHTML('beforeend', HTML);
    const q = (sel) => host.querySelector(sel);
    const section = q('.build-update-section');
    let showing = null;

    function draw(w, mine) {
        const runs = `Runs file ${short(w.runs?.sha256)}`
            + (w.runs?.flow_sha256 ? ` with flow ${short(w.runs.flow_sha256)}.` : '.');
        const waiting = w.waiting && w.asks
            ? ` An update to ${w.name} asks to ${w.asks}. It stays as it is until`
              + ' you allow it.'
            : '';
        q('.build-update').textContent = runs + waiting;
        const acts = q('.build-update-acts');
        if (!w.waiting || !w.asks || !mine) { acts.replaceChildren(); return; }
        const allow = el('button', { type: 'button', className: 'build-allow primary',
            textContent: 'Allow' });
        allow.onclick = async () => {
            try {
                draw(await api.rpc('allow_update', { p_instance: showing }), mine);
                q('.build-update-said').textContent = `${w.name} runs its latest version.`;
            } catch (err) {
                q('.build-update-said').textContent = String(err.body?.message ?? err.message);
            }
        };
        acts.replaceChildren(allow);
    }

    async function show(row, mine) {
        showing = row?.id ?? null;
        q('.build-update-said').textContent = '';
        const w = showing ? await api.rpc('update_waiting', { p_instance: showing })
            .catch(() => null) : null;
        section.hidden = !w;
        if (w) draw(w, mine);
    }
    return { show };
}
