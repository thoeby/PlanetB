// shapesave.js — Shape's Save, what happens when it cannot, and leaving with
// strokes unsaved (EDT.10, PLAN-editors.md §2.2).
//
// Save writes one new r32 (Invariant 1) and then height_edit; the tiles under
// the moved cells go `changed`. If the file store or PostgREST does not
// answer, the grid is kept on this machine (client/js/shapekeep.js) and Retry
// is offered; a reload puts it back. Leaving the surface with strokes unsaved
// asks Save / Discard / Stay.

import { forget, keep } from './shapekeep.js';
import { el } from './tabbar.js';

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export async function saveGround(state, say, ctx, retry) {
    if (!state.shaping?.dirty) { say('nothing shaped yet'); return null; }
    const strokes = state.shaping.strokes.length;
    try {
        const got = await state.shaping.save();
        await forget(state.shaping).catch(() => {});
        retry.hidden = true;
        say(`ground saved · ${plural(Number(got.tiles ?? 0), 'tile')} changed`);
        ctx.bp.rebuild(null);
        ctx.onSaved?.();
        ctx.notify?.({ text: `ground saved · ${plural(Number(got.tiles ?? 0), 'tile')}`
            + ' changed' });
        return got;
    } catch (err) {
        const kept = await keep(state.shaping).then(() => true, () => false);
        retry.hidden = false;
        const why = String(err.body?.message ?? err.message ?? err);
        say(kept ? `${plural(strokes, 'stroke')} kept on this machine — the save did`
            + ` not go through (${why}). Retry when it answers.` : why, true);
        return null;
    }
}

// The question asked on the way out: three buttons over the world.
export function mountLeave(host) {
    const words = el('p', {});
    const node = el('div', { id: 'sh-leave', className: 'glass', hidden: true }, words,
        el('div', { className: 'row' },
            el('button', { type: 'button', className: 'sh-leave-save primary',
                textContent: 'Save' }),
            el('button', { type: 'button', className: 'sh-leave-discard',
                textContent: 'Discard' }),
            el('button', { type: 'button', className: 'sh-leave-stay', textContent: 'Stay' })));
    host.append(node);
    return {
        node,
        // Answers 'save', 'discard' or 'stay'.
        ask(text) {
            words.textContent = text;
            node.hidden = false;
            return new Promise((resolve) => {
                for (const [cls, answer] of [['save', 'save'], ['discard', 'discard'],
                    ['stay', 'stay']]) {
                    node.querySelector(`.sh-leave-${cls}`).onclick = () => {
                        node.hidden = true;
                        resolve(answer);
                    };
                }
            });
        },
    };
}
