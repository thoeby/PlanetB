// noop.js — the atom the worker runtime is tested with (WP2.2).
//
// It computes nothing about the world. It exists so the loop that claims,
// fetches, runs, uploads, registers and submits can be exercised end to end
// against the real database and the real file store, without a GPU and without
// a real op's minutes of work. It is deterministic — the same atom always
// produces the same bytes — because every op in this system is.

export async function run({ atom, inputs, canvas, log }) {
    // Proof that the worker really has an OffscreenCanvas: WP2.4's frame atom
    // will render into one, and a tab that cannot make one cannot do that work.
    const ctx = canvas(2, 2).getContext('2d');
    ctx.fillStyle = '#123456';
    ctx.fillRect(0, 0, 2, 2);
    const pixel = Array.from(ctx.getImageData(0, 0, 1, 1).data);

    const seen = Object.fromEntries(Object.entries(inputs ?? {}).map(
        ([k, v]) => [k, v?.byteLength ?? (Array.isArray(v) ? v.length : v)]));
    log({ event: 'noop', atom: atom.id, inputs: seen });

    const body = JSON.stringify({
        op: atom.op, atom_hash: atom.atom_hash, seed: atom.seed,
        params: atom.params, inputs: seen, pixel,
    });
    return {
        files: [{ ext: 'json', kind: 'ply', bytes: new TextEncoder().encode(body) }],
        output: 'json',
        result: { bytes: body.length, splat_count: 0, finite: true },
    };
}
