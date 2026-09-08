// gsmath.js — one gaussian, one camera: where it lands and how wide it is.
//
// The EWA projection every 3D-gaussian renderer uses. A gaussian is a mean, a
// scale and a rotation in the tile's own frame; seen from a camera it is an
// ellipse on the image, described by the inverse of its 2D covariance (the
// "conic"). `verify` renders with this and `train` differentiates through it
// (client/lib/gsgrad.js), so the two agree by construction.
//
// The camera convention is the one client/lib/cameras.js writes into
// transforms.json: +X right, +Y up, looking down -Z, and pixel rows counted
// from the top.

// A splat is never thinner than a pixel: px^2 added to the 2D covariance.
export const BLUR = 0.3;
// How far out the ellipse is drawn, in standard deviations.
export const CUTOFF = 3;
// The sky the frame atom clears to (client/lib/render.js), which is what the
// gaussians are composited over here.
export const SKY = [0.55, 0.68, 0.85];

// transforms.json carries camera-to-world, row-major: columns are right, up,
// back and the position. The renderer wants world-to-camera.
export function cameraFrom(m, intr) {
    const col = (k) => [m[0][k], m[1][k], m[2][k]];
    const [right, up, back, pos] = [col(0), col(1), col(2), col(3)];
    const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const scale = (intr.size ?? intr.w) / intr.w;
    return {
        // Rows of W are the camera's axes: p_cam = W p_world + t.
        w: [...right, ...up, ...back],
        t: [-dot(right, pos), -dot(up, pos), -dot(back, pos)],
        fx: intr.fl_x * scale, fy: intr.fl_y * scale,
        cx: intr.cx * scale, cy: intr.cy * scale,
        width: Math.round(intr.w * scale), height: Math.round(intr.h * scale),
        near: intr.near ?? 0.2,
    };
}

// The upper triangle of R S S^T R^T, with S = diag(s) and R from a normalised
// quaternion: [c00, c01, c02, c11, c12, c22].
export function cov3d(s, q) {
    const n = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
    const [w, x, y, z] = [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
    // Columns of R, each already scaled: M = R S, and Sigma = M M^T.
    const m = [
        (1 - 2 * (y * y + z * z)) * s[0], (2 * (x * y - w * z)) * s[1],
        (2 * (x * z + w * y)) * s[2],
        (2 * (x * y + w * z)) * s[0], (1 - 2 * (x * x + z * z)) * s[1],
        (2 * (y * z - w * x)) * s[2],
        (2 * (x * z - w * y)) * s[0], (2 * (y * z + w * x)) * s[1],
        (1 - 2 * (x * x + y * y)) * s[2],
    ];
    const row = (r) => [m[r * 3], m[r * 3 + 1], m[r * 3 + 2]];
    const d = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const [r0, r1, r2] = [row(0), row(1), row(2)];
    return [d(r0, r0), d(r0, r1), d(r0, r2), d(r1, r1), d(r1, r2), d(r2, r2)];
}

// p_cam = W p + t, and the depth the sorting uses.
export function toCamera(cam, px, py, pz) {
    const w = cam.w;
    return {
        x: w[0] * px + w[1] * py + w[2] * pz + cam.t[0],
        y: w[3] * px + w[4] * py + w[5] * pz + cam.t[1],
        z: w[6] * px + w[7] * py + w[8] * pz + cam.t[2],
    };
}

// d(pixel)/d(camera point). Rows are u and v; the camera looks down -Z, so
// depth is -z and the image's v grows downwards.
export function jacobian(cam, p, depth) {
    const inv = 1 / depth;
    return [
        cam.fx * inv, 0, cam.fx * p.x * inv * inv,
        0, -cam.fy * inv, -cam.fy * p.y * inv * inv,
    ];
}

// J W Sigma (J W)^T, the 2D covariance in pixels. `s3` is the upper triangle.
export function cov2d(cam, p, depth, s3) {
    const j = jacobian(cam, p, depth);
    const w = cam.w;
    // T = J W, 2x3.
    const t = [0, 0, 0, 0, 0, 0];
    for (let r = 0; r < 2; r++) {
        for (let c = 0; c < 3; c++) {
            t[r * 3 + c] = j[r * 3] * w[c] + j[r * 3 + 1] * w[3 + c] + j[r * 3 + 2] * w[6 + c];
        }
    }
    const sig = [s3[0], s3[1], s3[2], s3[1], s3[3], s3[4], s3[2], s3[4], s3[5]];
    const mul = (r, k) => t[r * 3] * sig[k] + t[r * 3 + 1] * sig[3 + k] + t[r * 3 + 2] * sig[6 + k];
    const ts = [mul(0, 0), mul(0, 1), mul(0, 2), mul(1, 0), mul(1, 1), mul(1, 2)];
    const d = (r, c) => ts[r * 3] * t[c * 3] + ts[r * 3 + 1] * t[c * 3 + 1]
        + ts[r * 3 + 2] * t[c * 3 + 2];
    return { a: d(0, 0) + BLUR, b: d(0, 1), c: d(1, 1) + BLUR, t };
}

// Where a splat lands, how wide, and the conic that shapes it. Null when the
// camera cannot see it at all.
export function project(cam, mean, s3) {
    const p = toCamera(cam, mean[0], mean[1], mean[2]);
    const depth = -p.z;
    if (depth < cam.near) return null;
    const u = cam.cx + cam.fx * p.x / depth;
    const v = cam.cy - cam.fy * p.y / depth;
    const { a, b, c, t } = cov2d(cam, p, depth, s3);
    const det = a * c - b * b;
    if (!(det > 1e-12)) return null;
    // The larger eigenvalue of a symmetric 2x2 bounds the ellipse.
    const mid = (a + c) / 2;
    const off = Math.sqrt(Math.max(0.01, mid * mid - det));
    const radius = Math.ceil(CUTOFF * Math.sqrt(mid + off));
    if (u + radius < 0 || u - radius >= cam.width
        || v + radius < 0 || v - radius >= cam.height) return null;
    return { u, v, depth, radius, cov: [a, b, c], p, t,
        conic: [c / det, -b / det, a / det] };
}

export const sigmoid = (v) => 1 / (1 + Math.exp(-v));
export const logit = (p) => Math.log(p / (1 - p));
