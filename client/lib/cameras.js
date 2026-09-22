// cameras.js — the camera sets `frame` renders and `train` learns from.
//
// A set is a fixed list of poses: the same set over the same bounds gives the
// same cameras on every machine, and a pose id is its index in that list
// (ARCHITECTURE §6). db/0005_jobs.sql's camera_views() must agree with the
// counts here: z18-v1 is 120 views, z16-v1 is 56.

const RAD = Math.PI / 180;

// Rings orbit the middle at a few elevations; obliques aim at a grid of points
// over the tile from two heights, so every part of the ground is seen close
// and from several sides — the overlap 3DGS needs, which loops of a camera
// looking along its own path (the street loops before) did not give it.
export const SETS = {
    'z18-v1': { rings: [20, 35, 55], az: 24, grid: 4, perTarget: 2, top: 16 },
    'z16-v1': { rings: [25, 45], az: 24, grid: 0, perTarget: 0, top: 8 },
    // Stations over the ground, not rings round a point. v1's two rings all
    // looked at the middle from 570 m out: the corners of a 1.7 km tile were
    // at the edge of every frame or past it, the same ground was seen from the
    // same distance 48 times, and the eight top-downs from 1.4 km saw past the
    // tile into the void. v2 is a 3 x 3 grid of stations across the tile,
    // each looked at straight down from high enough that the nadir footprint
    // overlaps its neighbours' by half, and from four sides at 55° from low
    // enough that the ground is close — the overlap and the parallax
    // photogrammetry wants. 9 + 36 = 45.
    'z16-v2': { rings: [], az: 0, grid: 0, perTarget: 0, top: 0, stations: 3, sides: 4 },
    // v2's stations see every part of the ground close and from above, and
    // nothing else does: a tile trained on them matched all 45 frames and
    // was a field of blobs from where a player actually stands — far off and
    // low, looking across it. v3 keeps the stations and adds three rings of
    // twelve at 1.8 extents out, at 12°, 25° and 40°: the whole tile in
    // frame from every side, low enough to see the sides of things, which
    // is the view the trainer has to be held to. 45 + 36 = 81.
    'z16-v3': { rings: [12, 25, 40], az: 12, ringDist: 1.8, grid: 0, perTarget: 0, top: 0,
        stations: 3, sides: 4 },
};

// How many poses a set has, or 0 for a set this build does not know — a name
// that arrives in an atom's params, so it is data and not a promise. The caller
// falls back to the frames it was handed; throwing here took the whole atom
// down with "can't access property rings".
export const viewCount = (set) => {
    const s = SETS[set];
    if (!s) return 0;
    return s.rings.length * s.az + s.grid * s.grid * s.perTarget + s.top
        + (s.stations ?? 0) ** 2 * (1 + (s.sides ?? 0));
};

// A pose looking straight down has no "up" in the sky: its basis would be
// built from up × back with both vertical, and every top-down frame came out
// of a zero rotation. Those poses take north as up instead.
const vertical = (p, t) => {
    const d = [t[0] - p[0], t[1] - p[1], t[2] - p[2]];
    return Math.abs(d[1]) > 0.999 * Math.hypot(d[0], d[1], d[2]);
};

const look = (position, target, id, kind) => ({
    id, kind, position, target, fov: 60,
    up: vertical(position, target) ? [0, 0, -1] : [0, 1, 0],
});

// The stations of z16-v2, lifted out of cameraSet so that each of its four
// kinds of eye reads on one screen. A grid of points over the tile, each seen
// from straight above and from `sides` compass directions at 55° down. Spacing
// s is the tile over the count; the nadir height makes a 60° footprint two
// spacings wide, so neighbours overlap by half; an oblique stands 0.45 s out
// from its point, which puts it 0.64 s up. Alternate stations turn the compass
// by half a step, so no two neighbours look from the same sides. Every eye
// stands above the ground it is over.
function stations(out, s, bounds, at) {
    const { centre: c, extent: e } = bounds;
    const st = s.stations ?? 0;
    for (let gy = 0; gy < st; gy++) {
        for (let gx = 0; gx < st; gx++) {
            const spacing = 2 * e / st;
            const tx = c[0] + ((gx + 0.5) / st * 2 - 1) * e;
            const tz = c[2] + ((gy + 0.5) / st * 2 - 1) * e;
            const t = [tx, at(tx, tz, c[1]), tz];
            const nadir = [tx, Math.max(t[1] + spacing * 1.73, at(tx, tz, -Infinity) + 5), tz];
            out.push(look(nadir, t, out.length, 'top'));
            const turn = ((gx + gy) % 2) * Math.PI / s.sides;
            for (let k = 0; k < s.sides; k++) {
                const a = turn + (k / s.sides) * Math.PI * 2;
                const d = spacing * 0.45;
                const px = tx + Math.cos(a) * d;
                const pz = tz + Math.sin(a) * d;
                const py = Math.max(t[1] + d * Math.tan(55 * RAD), at(px, pz, -Infinity) + 5);
                out.push(look([px, py, pz], t, out.length, 'oblique'));
            }
        }
    }
}

// bounds: { centre: [x, y, z], extent } in the tile's own frame, metres.
// ground(x, z): the terrain's height there, or null where it is not known.
// Without it the poses sit at heights taken from the bounds alone, which in a
// valley or on a slope put a street camera underground and a ring looking
// through a hill; with it every eye stands on the ground it is over.
export function cameraSet(name, bounds, ground = null) {
    const s = SETS[name];
    if (!s) throw new Error(`no camera set ${name}`);
    const { centre: c, extent: e } = bounds;
    const at = (x, z, fallback) => ground?.(x, z) ?? fallback;
    const middle = [c[0], at(c[0], c[2], c[1]), c[2]];
    const out = [];

    // Orbits: three or two rings of 24 azimuths, looking at the middle, and
    // never below the ground they are over plus a little.
    const dist = e * (s.ringDist ?? 0.95);
    for (const elev of s.rings) {
        for (let i = 0; i < s.az; i++) {
            const a = (i / s.az) * Math.PI * 2;
            const r = dist * Math.cos(elev * RAD);
            const h = dist * Math.sin(elev * RAD);
            const px = c[0] + Math.cos(a) * r;
            const pz = c[2] + Math.sin(a) * r;
            const py = Math.max(middle[1] + h, at(px, pz, -Infinity) + Math.max(3, e * 0.05));
            out.push(look([px, py, pz], middle, out.length, 'ring'));
        }
    }

    // Obliques: a grid of points over the tile, each looked at from a high
    // and a low angle, from azimuths that walk round the compass. Standing on
    // the ground they are over, never in it.
    const GOLDEN = 2.399963;
    for (let gy = 0; gy < s.grid; gy++) {
        for (let gx = 0; gx < s.grid; gx++) {
            const tx = c[0] + ((gx + 0.5) / s.grid * 2 - 1) * e * 0.8;
            const tz = c[2] + ((gy + 0.5) / s.grid * 2 - 1) * e * 0.8;
            const t = [tx, at(tx, tz, c[1]), tz];
            for (let k = 0; k < s.perTarget; k++) {
                const elev = (k ? 45 : 15) * RAD;
                const dist = e * (k ? 0.45 : 0.3);
                const a = (gy * s.grid + gx) * GOLDEN + k * Math.PI;
                const px = tx + Math.cos(a) * dist * Math.cos(elev);
                const pz = tz + Math.sin(a) * dist * Math.cos(elev);
                const py = Math.max(t[1] + Math.sin(elev) * dist, at(px, pz, -Infinity) + 2);
                out.push(look([px, py, pz], t, out.length, 'oblique'));
            }
        }
    }

    stations(out, s, bounds, at);

    // Top-down: a square grid over the tile when the count is one, else one
    // over the middle and the rest around it, so the roofs and the ground
    // between the orbits are seen from above.
    const side = Math.round(Math.sqrt(s.top));
    for (let i = 0; i < s.top; i++) {
        let px; let pz;
        if (side * side === s.top) {
            px = c[0] + (((i % side) + 0.5) / side * 2 - 1) * e * 0.75;
            pz = c[2] + ((Math.floor(i / side) + 0.5) / side * 2 - 1) * e * 0.75;
        } else {
            const a = (i / Math.max(s.top - 1, 1)) * Math.PI * 2;
            const r = i === 0 ? 0 : e * 0.45;
            px = c[0] + Math.cos(a) * r;
            pz = c[2] + Math.sin(a) * r;
        }
        const p = [px, at(px, pz, c[1]) + e * 1.6, pz];
        out.push(look(p, [p[0], at(px, pz, c[1]), p[2]], out.length, 'top'));
    }
    return out;
}

// ------------------------------------------------------------------ matrices

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0]];
const norm = (v) => {
    const l = Math.hypot(v[0], v[1], v[2]) || 1;
    return [v[0] / l, v[1] / l, v[2] / l];
};
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

// Camera-to-world, OpenGL convention: +X right, +Y up, looking down -Z. This is
// what transforms.json carries and what train reads back.
export function cameraToWorld(cam) {
    const back = norm(sub(cam.position, cam.target));
    const right = norm(cross(cam.up, back));
    const up = cross(back, right);
    return [
        [right[0], up[0], back[0], cam.position[0]],
        [right[1], up[1], back[1], cam.position[1]],
        [right[2], up[2], back[2], cam.position[2]],
        [0, 0, 0, 1],
    ];
}

// Column-major view matrix, for WebGL.
export function viewMatrix(cam) {
    const back = norm(sub(cam.position, cam.target));
    const right = norm(cross(cam.up, back));
    const up = cross(back, right);
    return new Float32Array([
        right[0], up[0], back[0], 0,
        right[1], up[1], back[1], 0,
        right[2], up[2], back[2], 0,
        -dot(right, cam.position), -dot(up, cam.position), -dot(back, cam.position), 1,
    ]);
}

export function perspective(fovDeg, aspect, near, far) {
    const f = 1 / Math.tan(fovDeg * RAD / 2);
    return new Float32Array([
        f / aspect, 0, 0, 0,
        0, f, 0, 0,
        0, 0, (far + near) / (near - far), -1,
        0, 0, (2 * far * near) / (near - far), 0,
    ]);
}

// nerfstudio's transforms.json, OPENCV camera model with a square sensor.
// `ply_file_path` names the seed assemble writes beside its scene: brush
// starts from it when the file is there (brush-dataset nerfstudio.rs) and
// from random points in the frustums when it is not, which is what its own
// app did with a dataset unpacked whole (tools/dataset.mjs --all) before the
// name was in here.
export function transformsJson(cams, size, files) {
    const f = size / 2 / Math.tan(cams[0].fov * RAD / 2);
    return {
        camera_model: 'OPENCV',
        fl_x: f, fl_y: f, cx: size / 2, cy: size / 2, w: size, h: size,
        k1: 0, k2: 0, p1: 0, p2: 0,
        ply_file_path: 'init.ply',
        frames: cams.map((cam, i) => ({
            file_path: files[i],
            pose_id: cam.id,
            kind: cam.kind,
            transform_matrix: cameraToWorld(cam),
        })),
    };
}
