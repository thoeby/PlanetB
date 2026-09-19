// setupground.js — the two buttons of Setup that act on the ground the store
// has already cut: cut it again (db/0154) and draw every frame again (db/0149).
// Split from setupui.js, which they pushed past four hundred lines.

import * as api from './api.js';

// Every open job there is, drawing its views again and training on the new
// ones (db/0149). The elevation changed under tiles that were already framed
// — a layer added, a cut that has since been fixed — and their frames are of
// the old ground. Nothing is compiled from scratch and no version moves.
export async function frames(q, say) {
    q('.gs-frames').disabled = true;
    say('.gs-ground', 'asking every open tile for its frames again\u2026');
    try {
        const n = await api.rpc('redo_ground_renders', {});
        say('.gs-ground', n
            ? `${n} tile(s) will draw their views again, and train on them`
            : 'no open tile has frames of its own to draw again');
    } catch (err) {
        say('.gs-ground', `could not: ${String(err.body?.message ?? err.message ?? err)}`, true);
        console.error(err);
    } finally {
        q('.gs-frames').disabled = false;
    }
}

// The same coverage, a new survey behind it (db/0154 recut_ground): every cut
// the store has is of the old one and every tab is holding copies it was told
// to keep for a year. This forgets them all; the maps ask again as they are
// drawn. What is already compiled is left alone — that is the button beside
// this one.
export async function recut(q, say, onRecut) {
    q('.gs-recut').disabled = true;
    say('.gs-ground', 'forgetting every cut of the ground\u2026');
    try {
        const out = await api.rpc('recut_ground', {});
        const g = await api.rpc('ground').catch(() => null);
        say('.gs-ground', `${out?.forgotten ?? 0} cut tile(s) forgotten \u2014 the`
            + ' ground is cut again as it is asked for');
        // The mark the RPC answered with, not whatever a second read happens
        // to see: it is what every cut is now asked for under.
        onRecut({ ...(g ?? {}), set_at: out?.cut_at ?? g?.set_at ?? '' });
    } catch (err) {
        say('.gs-ground', `could not: ${String(err.body?.message ?? err.message ?? err)}`,
            true);
    } finally {
        q('.gs-recut').disabled = false;
    }
}
