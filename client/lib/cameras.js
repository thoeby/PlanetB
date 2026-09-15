// cameras.js — the camera sets `frame` renders and `train` learns from.
//
// A set is a fixed list of poses: the same set over the same bounds gives the
// same cameras on every machine, and a pose id is its index in that list
// (ARCHITECTURE §6). db/0005_jobs.sql's camera_views() must agree with the
// counts here: z18-v1 is 120 views, z16-v1 is 56.

const RAD = Math.PI / 180;

export const SETS = {
    'z18-v1': { rings: [15, 30, 55], az: 24, streets: 4, perStreet: 10, top: 8 },
    'z16-v1': { rings: [20, 45], az: 24, streets: 0, perStreet: 0, top: 8 },
};

// How many poses a set has, or 0 for a set this build does not know — a name
// that arrives in an atom's params, so it is data and not a promise. The caller
// falls back to the frames it was handed; throwing here took the whole atom
// down with "can't access property rings".
export const viewCount = (set) => {
    const s = SETS[set];
    if (!s) return 0;
    return s.rings.length * s.az + s.streets * s.perStreet + s.top;
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
    for (const elev of s.rings) {
        for (let i = 0; i < s.az; i++) {
            const a = (i / s.az) * Math.PI * 2;
            const r = e * 0.95 * Math.cos(elev * RAD);
            const h = e * 0.95 * Math.sin(elev * RAD);
            const px = c[0] + Math.cos(a) * r;
            const pz = c[2] + Math.sin(a) * r;
            const py = Math.max(middle[1] + h, at(px, pz, -Infinity) + Math.max(3, e * 0.05));
            out.push(look([px, py, pz], middle, out.length, 'ring'));
        }
    }

    // Street loops: eye height over the ground, walking a circle and looking
    // along it, which is the view a player actually gets and the one z18 has
    // to be sharp for.
    for (let l = 0; l < s.streets; l++) {
        const r = e * (0.2 + 0.15 * l);
        for (let i = 0; i < s.perStreet; i++) {
            const a = (i / s.perStreet) * Math.PI * 2 + l * 0.31;
            const ahead = a + 0.6;
            const px = c[0] + Math.cos(a) * r;
            const pz = c[2] + Math.sin(a) * r;
            const tx = c[0] + Math.cos(ahead) * r * 1.4;
            const tz = c[2] + Math.sin(ahead) * r * 1.4;
            out.push(look([px, at(px, pz, c[1]) + 1.7, pz],
                [tx, at(tx, tz, c[1]) + 1.0, tz], out.length, 'street'));
        }
    }

    // Top-down: one over the middle and seven around it, so the roofs and the
    // ground between the orbits are seen from above.
    for (let i = 0; i < s.top; i++) {
        const a = (i / Math.max(s.top - 1, 1)) * Math.PI * 2;
        const r = i === 0 ? 0 : e * 0.45;
        const px = c[0] + Math.cos(a) * r;
        const pz = c[2] + Math.sin(a) * r;
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
export function transformsJson(cams, size, files) {
    const f = size / 2 / Math.tan(cams[0].fov * RAD / 2);
    return {
        camera_model: 'OPENCV',
        fl_x: f, fl_y: f, cx: size / 2, cy: size / 2, w: size, h: size,
        k1: 0, k2: 0, p1: 0, p2: 0,
        frames: cams.map((cam, i) => ({
            file_path: files[i],
            pose_id: cam.id,
            kind: cam.kind,
            transform_matrix: cameraToWorld(cam),
        })),
    };
}
