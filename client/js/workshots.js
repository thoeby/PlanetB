// workshots.js — the pictures a tab took of the tiles it worked on.
//
// Two per tile and the newest of each: a traced frame while the tile is being
// drawn, and the splats as they are fitted. Those are two different things to
// look at — what the tile should be, and what the trainer has made of it so
// far — and one map keeping whichever was last meant the frames were gone the
// moment training started.
//
// Split out of client/js/work.js when that file passed the four hundred lines
// CLAUDE.md allows. It keeps no policy: the loop hands it every record and it
// remembers the ones with a picture on them.

// How many tiles' pictures to keep. A picture is a few hundred kilobytes of
// rgba and a tab works through a lot of tiles.
export const KEEP = 24;

export class Shots {
    constructor(keep = KEEP) {
        this.keep = keep;
        this.held = new Map();
        // A `frame` record carries no tile of its own (client/atoms/frame.js),
        // so the tile is the last one any record named. Without that every
        // frame picture was thrown away and only the training was ever seen.
        this.onTile = null;
    }

    // Which of the two a picture is: a traced frame arrives as webp bytes from
    // the renderer, the splats as rgba the tab drew itself.
    static kindOf = (rec) => (rec?.picture?.webp ? 'frame' : 'splat');

    saw(rec) {
        if (rec?.tile) this.onTile = rec.tile;
        if (!rec?.picture) return null;
        const tile = rec.tile ?? this.onTile;
        if (!tile) return null;
        const key = `${tile.z}/${tile.x}/${tile.y}`;
        const was = this.held.get(key) ?? {};
        this.held.set(key, { ...was, tile, [Shots.kindOf(rec)]: { ...rec, tile } });
        if (this.held.size > this.keep) this.held.delete(this.held.keys().next().value);
        return key;
    }

    get(key) { return this.held.get(key) ?? null; }

    get size() { return this.held.size; }
}

// The one to put on a card: the newer of the two, because what a tile is doing
// now is what somebody glancing at it wants to see. Both are on the opened
// card (client/js/jobdetail.js), where there is room to compare them.
export function newest(shots) {
    const both = [shots?.frame, shots?.splat].filter(Boolean);
    if (!both.length) return null;
    return both.sort((a, b) => (b.t ?? 0) - (a.t ?? 0))[0];
}

// What a picture is of, in words. The card used to say "256×256", which is the
// size of the thumbnail the tab drew and says nothing about the tile: it read
// as "this world is being rendered at 256 pixels", which it is not.
export function shotWords(rec) {
    if (!rec) return '';
    if (rec.event === 'frame') {
        return `frame ${rec.done ?? '?'} of ${rec.of ?? '?'}`;
    }
    if (rec.event === 'seeded') {
        return `the seed · ${count(rec.splats)} splats`;
    }
    if (rec.event === 'trained') return 'as it finished';
    const at = rec.iter != null && rec.of != null ? `step ${rec.iter} of ${rec.of}` : '';
    return [at, rec.splats ? `${count(rec.splats)} splats` : ''].filter(Boolean)
        .join(' · ') || 'training';
}

const count = (n) => Number(n ?? 0).toLocaleString();
