// assets.js — the canonical GLBs a tile's instances stand on, fetched by
// digest. Two hundred of the same bench are one file. A missing one is skipped,
// not fatal: one lost asset must not make a whole tile uncompilable (WP2
// deviation 43 is the same rule for a merge's missing child). `assemble` bakes
// them into the mesh, `frame` loads them whole for their textures.

export async function loadAssets(instances, { filesUrl = '', fetchFn = fetch } = {}) {
    const out = new Map();
    for (const i of instances ?? []) {
        if (!i.sha256 || out.has(i.sha256)) continue;
        const res = await fetchFn(`${filesUrl}/assets/${i.sha256}.glb`).catch(() => null);
        if (res?.ok) out.set(i.sha256, new Uint8Array(await res.arrayBuffer()));
    }
    return out;
}
