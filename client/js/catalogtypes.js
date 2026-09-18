// catalogtypes.js — the four products that are not a model.
//
// FND.5. Register asks "what is it" first and then shows one form: a repeating
// piece and a model are a GLB and share the model form; a surface material is a
// PNG; a road cross-section is typed; a collection is picked from what is
// already in the catalog. Each draws its own preview, because none of them
// looks like anything until it is drawn.
//
// Split out of catalogui.js for size (CLAUDE.md), and because the shell — find,
// cards, buy — is the same whatever is being registered.

import { el } from './poolui.js';
import { searchAssets, publishCollection, publishMaterial, publishProfile }
    from './catalog.js';
import { materialTrouble, profileWidth, stripsOf } from '../lib/product.js';

// ------------------------------------------------------------------ material

// A material is shown the way it will be used: tiled, not stretched.
export async function paintMaterial(canvas, bytes, tiling) {
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    // Four metres of ground across the preview, whatever the tiling is, so two
    // materials at different tilings look as different as they are.
    const across = Math.max(1, Math.round(4 / Math.max(0.05, Number(tiling) || 1)));
    const size = canvas.width / across;
    for (let y = 0; y < across; y++) {
        for (let x = 0; x < across; x++) {
            ctx.drawImage(bitmap, x * size, y * size, size, size);
        }
    }
    return { width: bitmap.width, height: bitmap.height };
}

// ------------------------------------------------------------------- profile

// The cross-section, drawn to scale: the ground is the line across the middle,
// every strip is a box on it, and the centre of the road is the dashed line.
export function paintProfile(canvas, profile) {
    const ctx = canvas.getContext('2d');
    const style = getComputedStyle(canvas);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const all = stripsOf(profile);
    const width = Math.max(1, profileWidth(profile));
    const scale = (canvas.width * 0.9) / width;
    const mid = canvas.width / 2;
    const ground = canvas.height * 0.72;

    ctx.strokeStyle = style.getPropertyValue('--edge') || 'rgba(255,255,255,0.2)';
    ctx.beginPath();
    ctx.moveTo(0, ground);
    ctx.lineTo(canvas.width, ground);
    ctx.stroke();
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(mid, 0);
    ctx.lineTo(mid, canvas.height);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = style.getPropertyValue('--accent') || '#6cf';
    ctx.strokeStyle = style.getPropertyValue('--ink') || '#fff';
    for (const s of all) {
        const w = Math.max(1, s.width * scale);
        const h = Math.max(2, Math.abs(s.height) * scale);
        const x = mid + (s.offset - s.width / 2) * scale;
        ctx.fillRect(x, ground - h, w, h);
        ctx.strokeRect(x, ground - h, w, h);
    }
    return { strips: all.length, width };
}

// One row of the cross-section form.
function stripRow(strip, onChange, onRemove) {
    const field = (key, placeholder, step) => {
        const input = el('input', { type: 'number', step, value: strip[key] ?? '',
            placeholder, className: `st-${key}` });
        input.oninput = () => { strip[key] = Number(input.value); onChange(); };
        return input;
    };
    const material = el('input', { type: 'text', value: strip.material ?? '',
        placeholder: 'material SAN', className: 'st-material' });
    material.oninput = () => { strip.material = material.value.trim(); onChange(); };
    const drop = el('button', { type: 'button', textContent: '−' });
    drop.onclick = onRemove;
    return el('li', { className: 'strip' },
        field('offset', 'offset m', '0.01'), field('width', 'width m', '0.01'),
        field('height', 'height m', '0.01'), material, drop);
}

export function mountProfileForm(host, { onChange } = {}) {
    const strips = [];
    const list = el('ul', { className: 'strips' });
    const canvas = el('canvas', { className: 'preview pf-preview', width: 320, height: 160 });
    const mirrored = el('input', { type: 'checkbox', className: 'pf-mirrored' });
    const said = el('p', { className: 'muted mono pf-said' });
    const value = () => ({ strips, mirrored: mirrored.checked });

    const draw = () => {
        const drawn = paintProfile(canvas, { strips: stripsOf(value()), mirrored: false });
        said.textContent = drawn.strips
            ? `${drawn.strips} strip(s) · ${drawn.width.toFixed(2)} m across`
            : 'nothing typed yet';
        onChange?.(value());
    };
    const redraw = () => {
        list.replaceChildren(...strips.map((s, i) => stripRow(s, draw, () => {
            strips.splice(i, 1);
            redraw();
        })));
        draw();
    };
    const add = el('button', { type: 'button', className: 'pf-add',
        textContent: 'Add a strip' });
    add.onclick = () => { strips.push({ offset: 0, width: 1, height: 0 }); redraw(); };
    mirrored.onchange = draw;

    host.append(el('div', { className: 'row' },
        el('label', {}, 'Mirrored', mirrored), add), list, canvas, said);
    redraw();
    return { value, strips, redraw };
}

// ---------------------------------------------------------------- collection

export function mountCollectionForm(host, { onChange } = {}) {
    const members = [];
    const list = el('ul', { className: 'members' });
    const search = el('input', { type: 'search', className: 'cl-search',
        placeholder: 'find a model by name' });
    const found = el('ul', { className: 'cl-found' });
    const said = el('p', { className: 'muted mono cl-said' });
    const value = () => members;

    const draw = () => {
        list.replaceChildren(...members.map((m, i) => {
            const weight = el('input', { type: 'number', step: '0.5', min: '0.5',
                value: m.weight, className: 'cl-weight' });
            weight.oninput = () => { m.weight = Number(weight.value); onChange?.(value()); };
            const drop = el('button', { type: 'button', textContent: '−' });
            drop.onclick = () => { members.splice(i, 1); draw(); };
            const li = el('li', {}, el('span', { textContent: `${m.name} (${m.san})` }),
                weight, drop);
            li.dataset.san = m.san;
            return li;
        }));
        said.textContent = members.length
            ? `${members.length} in it · ${members.map((m) => m.weight).join(' : ')}`
            : 'nothing in it yet';
        onChange?.(value());
    };

    search.onchange = async () => {
        const rows = await searchAssets({ search: search.value, limit: 12 });
        found.replaceChildren(...rows.map((a) => {
            const add = el('button', { type: 'button', className: 'cl-add',
                textContent: `${a.name} · ${a.type ?? 'model'}` });
            add.dataset.san = a.san;
            add.onclick = () => {
                if (!members.some((m) => m.san === a.san)) {
                    members.push({ san: a.san, name: a.name, weight: 1, type: a.type });
                }
                draw();
            };
            return el('li', {}, add);
        }));
    };

    host.append(el('div', { className: 'row' }, search), found, list, said);
    draw();
    return { value, members, draw };
}

// ------------------------------------------------------------------ publish

// What Register does for each of the three that are not a GLB. `say` is the
// panel's status line; the sentence a refusal comes back with is the world's.
export async function publishTyped(type, form, meta, say) {
    try {
        let san = null;
        if (type === 'material') {
            const trouble = materialTrouble(form.material);
            if (trouble) { say(trouble, true); return null; }
            san = await publishMaterial(form.material.bytes,
                { ...meta, tiling: form.material.tiling, px: form.material.width });
        } else if (type === 'profile') {
            san = await publishProfile(form.profile(), meta);
        } else if (type === 'collection') {
            san = await publishCollection(form.collection(), meta);
        }
        if (san) say(`published ${san}`);
        return san;
    } catch (err) {
        say(String(err.body?.message ?? err.message ?? err), true);
        return null;
    }
}
