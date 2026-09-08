// gswgslgrad.js — the backward half of the trainer, as WGSL.
//
// client/lib/gsgrad.js in a shader. The compositing gradient is accumulated per
// splat, which every pixel of a tile wants to write to at once: it goes into
// workgroup memory first, a chunk of the tile's list at a time, and only the
// chunk's totals reach the global buffer.
//
// `gscreen` holds nine floats per gaussian — u, v, conic(3), colour(3),
// opacity — as bit patterns, because WGSL has no float atomic.

export const CHUNK = 32;
export const SLOTS = 9;
export const PARAMS = 14;   // pos 3, logScale 3, quat 4, sh 3, logit 1

// dL/d(pixel). The targets of every view live on the device as packed bytes;
// the uniform says where this one starts.
export const LOSS = `
@group(0) @binding(0) var<storage, read> image: array<f32>;
@group(0) @binding(1) var<storage, read> targets: array<u32>;
@group(0) @binding(2) var<storage, read_write> dL: array<f32>;
@group(0) @binding(3) var<uniform> cam: Cam;

const L2_SHARE: f32 = 0.2;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let n = cam.dims.x * cam.dims.y * 3u;
  let i = gid.x;
  if (i >= n) { return; }
  let byte = u32(cam.misc.w) + i;
  let want = f32((targets[byte >> 2u] >> ((byte & 3u) * 8u)) & 255u) / 255.0;
  let e = image[i] - want;
  dL[i] = ((1.0 - L2_SHARE) * sign(e) + 2.0 * L2_SHARE * e) / f32(n);
}
`;

export const BACKWARD = `
@group(0) @binding(0) var<storage, read> pre: array<f32>;
@group(0) @binding(1) var<storage, read> tileCount: array<u32>;
@group(0) @binding(2) var<storage, read> tileItems: array<u32>;
@group(0) @binding(3) var<storage, read> rest: array<f32>;
@group(0) @binding(4) var<storage, read> last: array<u32>;
@group(0) @binding(5) var<storage, read> dL: array<f32>;
@group(0) @binding(6) var<storage, read_write> gscreen: array<atomic<u32>>;
@group(0) @binding(7) var<uniform> cam: Cam;

const CHUNK: u32 = ${CHUNK}u;
const SLOTS: u32 = ${SLOTS}u;
var<workgroup> acc: array<atomic<u32>, ${CHUNK * SLOTS}>;

fn addAcc(i: u32, v: f32) {
  if (v == 0.0) { return; }
  var old = atomicLoad(&acc[i]);
  loop {
    let next = bitcast<u32>(bitcast<f32>(old) + v);
    let r = atomicCompareExchangeWeak(&acc[i], old, next);
    if (r.exchanged) { break; }
    old = r.old_value;
  }
}

fn addScreen(i: u32, v: f32) {
  var old = atomicLoad(&gscreen[i]);
  loop {
    let next = bitcast<u32>(bitcast<f32>(old) + v);
    let r = atomicCompareExchangeWeak(&gscreen[i], old, next);
    if (r.exchanged) { break; }
    old = r.old_value;
  }
}

struct Walk { t: f32, acc: vec3f, lastAlpha: f32, lastColor: vec3f };

// One splat, one pixel, back to front: what its alpha and its colour cost.
fn oneSplat(g: u32, d: vec2f, w: Walk, dLp: vec3f, bg: f32, restFinal: f32,
            slot: u32) -> Walk {
  var s = w;
  let alpha = min(MAX_ALPHA, pre[g + 7u] * exp(
      -0.5 * (pre[g + 4u] * d.x * d.x + pre[g + 6u] * d.y * d.y)
      - pre[g + 5u] * d.x * d.y));
  s.t = s.t / (1.0 - alpha);
  let col = vec3f(pre[g + 21u], pre[g + 22u], pre[g + 23u]);
  s.acc = s.lastAlpha * s.lastColor + (1.0 - s.lastAlpha) * s.acc;
  addAcc(slot * SLOTS + 5u, alpha * s.t * dLp.x);
  addAcc(slot * SLOTS + 6u, alpha * s.t * dLp.y);
  addAcc(slot * SLOTS + 7u, alpha * s.t * dLp.z);
  var dAlpha = dot(col - s.acc, dLp) * s.t - restFinal / (1.0 - alpha) * bg;
  s.lastColor = col;
  s.lastAlpha = alpha;
  let gw = exp(-0.5 * (pre[g + 4u] * d.x * d.x + pre[g + 6u] * d.y * d.y)
               - pre[g + 5u] * d.x * d.y);
  let dG = pre[g + 7u] * dAlpha;
  addAcc(slot * SLOTS + 8u, gw * dAlpha);
  addAcc(slot * SLOTS, dG * gw * (pre[g + 4u] * d.x + pre[g + 5u] * d.y));
  addAcc(slot * SLOTS + 1u, dG * gw * (pre[g + 5u] * d.x + pre[g + 6u] * d.y));
  addAcc(slot * SLOTS + 2u, dG * gw * -0.5 * d.x * d.x);
  addAcc(slot * SLOTS + 3u, dG * gw * -d.x * d.y);
  addAcc(slot * SLOTS + 4u, dG * gw * -0.5 * d.y * d.y);
  return s;
}

@compute @workgroup_size(${'${TILE}'}, ${'${TILE}'})
fn main(@builtin(workgroup_id) wg: vec3u, @builtin(local_invocation_id) lo: vec3u,
        @builtin(local_invocation_index) li: u32) {
  let px = wg.x * TILE + lo.x;
  let py = wg.y * TILE + lo.y;
  let tile = wg.y * cam.dims.z + wg.x;
  let cap = u32(cam.misc.y);
  let n = min(tileCount[tile], cap);
  let inside = px < cam.dims.x && py < cam.dims.y;
  let at = select(0u, py * cam.dims.x + px, inside);
  let mine = select(0u, last[at], inside);
  let dLp = vec3f(dL[at * 3u], dL[at * 3u + 1u], dL[at * 3u + 2u]);
  let bg = dot(SKY, dLp);
  let restFinal = rest[at];
  let p = vec2f(f32(px) + 0.5, f32(py) + 0.5);
  var w = Walk(restFinal, vec3f(0.0), 0.0, vec3f(0.0));
  var chunk = i32((n + CHUNK - 1u) / CHUNK) - 1;
  while (chunk >= 0) {
    for (var s = li; s < CHUNK * SLOTS; s += TILE * TILE) { atomicStore(&acc[s], 0u); }
    workgroupBarrier();
    let base = u32(chunk) * CHUNK;
    let hi = min(base + CHUNK, min(n, mine));
    var k = hi;
    while (k > base) {
      k -= 1u;
      let g = tileItems[tile * cap + k] * STRIDE;
      let d = p - vec2f(pre[g], pre[g + 1u]);
      let power = -0.5 * (pre[g + 4u] * d.x * d.x + pre[g + 6u] * d.y * d.y)
                  - pre[g + 5u] * d.x * d.y;
      if (power <= 0.0 && min(MAX_ALPHA, pre[g + 7u] * exp(power)) >= MIN_ALPHA) {
        w = oneSplat(g, d, w, dLp, bg, restFinal, k - base);
      }
    }
    workgroupBarrier();
    flush(tile, cap, base, min(base + CHUNK, n), li);
    workgroupBarrier();
    chunk -= 1;
  }
}

fn flush(tile: u32, cap: u32, base: u32, hi: u32, li: u32) {
  for (var s = li; s < CHUNK * SLOTS; s += TILE * TILE) {
    let j = s / SLOTS;
    if (base + j >= hi) { continue; }
    let v = bitcast<f32>(atomicLoad(&acc[s]));
    if (v == 0.0) { continue; }
    addScreen(tileItems[tile * cap + base + j] * SLOTS + (s % SLOTS), v);
  }
}
`;

// The projection stage of client/lib/gsgrad.js: screen-space gradients back to
// the parameters. One thread per gaussian, no atomics — each owns its row.
export const PROJECT = `
@group(0) @binding(0) var<storage, read> pre: array<f32>;
@group(0) @binding(1) var<storage, read> gscreen: array<f32>;
@group(0) @binding(2) var<storage, read> logScale: array<f32>;
@group(0) @binding(3) var<storage, read> quat: array<f32>;
@group(0) @binding(4) var<storage, read_write> gparam: array<f32>;
@group(0) @binding(5) var<uniform> cam: Cam;

const SLOTS: u32 = ${SLOTS}u;
const PARAMS: u32 = ${PARAMS}u;
const SH_C0: f32 = 0.28209479177387814;

struct Rows { a: vec3f, b: vec3f, c: vec3f };

fn conicToCov(cv: vec3f, gc: vec3f) -> vec3f {
  let det = cv.x * cv.z - cv.y * cv.y;
  let inv2 = 1.0 / (det * det);
  return vec3f(
    inv2 * (-cv.z * cv.z * gc.x + cv.y * cv.z * gc.y - cv.y * cv.y * gc.z),
    inv2 * (2.0 * cv.y * cv.z * gc.x - (det + 2.0 * cv.y * cv.y) * gc.y
            + 2.0 * cv.x * cv.y * gc.z),
    inv2 * (-cv.y * cv.y * gc.x + cv.x * cv.y * gc.y - cv.x * cv.x * gc.z));
}

fn quatGrad(q: vec4f, r0: vec3f, r1: vec3f, r2: vec3f, norm: f32) -> vec4f {
  let w = q.x; let x = q.y; let y = q.z; let z = q.w;
  let g = 2.0 * vec4f(
    -z * r0.y + y * r0.z + z * r1.x - x * r1.z - y * r2.x + x * r2.y,
    y * r0.y + z * r0.z + y * r1.x - 2.0 * x * r1.y - w * r1.z + z * r2.x
      + w * r2.y - 2.0 * x * r2.z,
    -2.0 * y * r0.x + x * r0.y + w * r0.z + x * r1.x + z * r1.z - w * r2.x
      + z * r2.y - 2.0 * y * r2.z,
    -2.0 * z * r0.x - w * r0.y + x * r0.z + w * r1.x - 2.0 * z * r1.y + y * r1.z
      + x * r2.x + y * r2.y);
  return (g - q * dot(g, q)) / norm;
}

// Sigma3 = M M^T with M = R S; back to the scales and the raw quaternion.
fn shapeGrad(i: u32, g3: Rows, s: vec3f, raw: vec4f) {
  let norm = max(length(raw), 1e-12);
  let q = raw / norm;
  let w = q.x; let x = q.y; let y = q.z; let z = q.w;
  let r0 = vec3f(1.0 - 2.0 * (y * y + z * z), 2.0 * (x * y - w * z), 2.0 * (x * z + w * y));
  let r1 = vec3f(2.0 * (x * y + w * z), 1.0 - 2.0 * (x * x + z * z), 2.0 * (y * z - w * x));
  let r2 = vec3f(2.0 * (x * z - w * y), 2.0 * (y * z + w * x), 1.0 - 2.0 * (x * x + y * y));
  let m0 = r0 * s; let m1 = r1 * s; let m2 = r2 * s;
  let s0 = vec3f(2.0 * g3.a.x, g3.a.y + g3.b.x, g3.a.z + g3.c.x);
  let s1 = vec3f(g3.a.y + g3.b.x, 2.0 * g3.b.y, g3.b.z + g3.c.y);
  let s2 = vec3f(g3.a.z + g3.c.x, g3.b.z + g3.c.y, 2.0 * g3.c.z);
  let gm0 = s0.x * m0 + s0.y * m1 + s0.z * m2;
  let gm1 = s1.x * m0 + s1.y * m1 + s1.z * m2;
  let gm2 = s2.x * m0 + s2.y * m1 + s2.z * m2;
  let gs = gm0 * r0 + gm1 * r1 + gm2 * r2;
  let gq = quatGrad(q, gm0 * s, gm1 * s, gm2 * s, norm);
  gparam[i * PARAMS + 3u] = gs.x * s.x;
  gparam[i * PARAMS + 4u] = gs.y * s.y;
  gparam[i * PARAMS + 5u] = gs.z * s.z;
  gparam[i * PARAMS + 6u] = gq.x; gparam[i * PARAMS + 7u] = gq.y;
  gparam[i * PARAMS + 8u] = gq.z; gparam[i * PARAMS + 9u] = gq.w;
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= cam.dims.w) { return; }
  for (var k = 0u; k < PARAMS; k++) { gparam[i * PARAMS + k] = 0.0; }
  let b = i * STRIDE;
  if (pre[b + 11u] == 0.0) { return; }
  let gcol = vec3f(gscreen[i * SLOTS + 5u], gscreen[i * SLOTS + 6u], gscreen[i * SLOTS + 7u]);
  let o = pre[b + 7u];
  gparam[i * PARAMS + 10u] = gcol.x * SH_C0;
  gparam[i * PARAMS + 11u] = gcol.y * SH_C0;
  gparam[i * PARAMS + 12u] = gcol.z * SH_C0;
  gparam[i * PARAMS + 13u] = gscreen[i * SLOTS + 8u] * o * (1.0 - o);

  let s = exp(vec3f(logScale[i * 3u], logScale[i * 3u + 1u], logScale[i * 3u + 2u]));
  let raw = vec4f(quat[i * 4u], quat[i * 4u + 1u], quat[i * 4u + 2u], quat[i * 4u + 3u]);
  let sig = covOf(s, raw);
  let gcov = conicToCov(vec3f(pre[b + 8u], pre[b + 9u], pre[b + 10u]),
    vec3f(gscreen[i * SLOTS + 2u], gscreen[i * SLOTS + 3u], gscreen[i * SLOTS + 4u]));
  let t0 = vec3f(pre[b + 12u], pre[b + 13u], pre[b + 14u]);
  let t1 = vec3f(pre[b + 15u], pre[b + 16u], pre[b + 17u]);
  let s0 = vec3f(sig.a.x, sig.a.y, sig.a.z);
  let s1 = vec3f(sig.a.y, sig.b.x, sig.b.y);
  let s2 = vec3f(sig.a.z, sig.b.y, sig.b.z);
  let st0 = vec3f(dot(s0, t0), dot(s1, t0), dot(s2, t0));
  let st1 = vec3f(dot(s0, t1), dot(s1, t1), dot(s2, t1));
  let g3 = Rows(gcov.x * t0.x * t0 + gcov.y * t0.x * t1 + gcov.z * t1.x * t1,
                gcov.x * t0.y * t0 + gcov.y * t0.y * t1 + gcov.z * t1.y * t1,
                gcov.x * t0.z * t0 + gcov.y * t0.z * t1 + gcov.z * t1.z * t1);
  let gt0 = 2.0 * gcov.x * st0 + gcov.y * st1;
  let gt1 = 2.0 * gcov.z * st1 + gcov.y * st0;
  meanGrad(i, b, gt0, gt1);
  shapeGrad(i, g3, s, raw);
}

// T = J W, so the mean moves the ellipse and reshapes it; both come back here.
fn meanGrad(i: u32, b: u32, gt0: vec3f, gt1: vec3f) {
  let c = vec3f(pre[b + 18u], pre[b + 19u], pre[b + 20u]);
  let d = -c.z;
  let j0 = vec3f(dot(gt0, cam.w0), dot(gt0, cam.w1), dot(gt0, cam.w2));
  let j1 = vec3f(dot(gt1, cam.w0), dot(gt1, cam.w1), dot(gt1, cam.w2));
  let gu = gscreen[i * SLOTS];
  let gv = gscreen[i * SLOTS + 1u];
  let gp = vec3f(
    j0.z * cam.fx / (d * d) + gu * cam.fx / d,
    j1.z * -cam.fy / (d * d) + gv * -cam.fy / d,
    j0.x * cam.fx / (d * d) + j0.z * 2.0 * cam.fx * c.x / (d * d * d)
      + j1.y * -cam.fy / (d * d) + j1.z * -2.0 * cam.fy * c.y / (d * d * d)
      + gu * cam.fx * c.x / (d * d) + gv * -cam.fy * c.y / (d * d));
  gparam[i * PARAMS] = cam.w0.x * gp.x + cam.w1.x * gp.y + cam.w2.x * gp.z;
  gparam[i * PARAMS + 1u] = cam.w0.y * gp.x + cam.w1.y * gp.y + cam.w2.y * gp.z;
  gparam[i * PARAMS + 2u] = cam.w0.z * gp.x + cam.w1.z * gp.y + cam.w2.z * gp.z;
}
`;

export const ADAM = `
struct Opt { lr: vec4f, lr2: vec4f, ab: vec4f };
@group(0) @binding(0) var<storage, read_write> pos: array<f32>;
@group(0) @binding(1) var<storage, read_write> logScale: array<f32>;
@group(0) @binding(2) var<storage, read_write> quat: array<f32>;
@group(0) @binding(3) var<storage, read_write> sh: array<f32>;
@group(0) @binding(4) var<storage, read_write> logit: array<f32>;
@group(0) @binding(5) var<storage, read> gparam: array<f32>;
@group(0) @binding(6) var<storage, read_write> mom: array<f32>;
@group(0) @binding(7) var<storage, read_write> vel: array<f32>;
@group(0) @binding(8) var<uniform> opt: Opt;

const PARAMS: u32 = ${PARAMS}u;

fn rateOf(k: u32) -> f32 {
  if (k < 3u) { return opt.lr.x * opt.lr2.w; }
  if (k < 6u) { return opt.lr.y; }
  if (k < 10u) { return opt.lr.z; }
  if (k < 13u) { return opt.lr.w; }
  return opt.lr2.x;
}

fn store(i: u32, k: u32, v: f32) {
  if (k < 3u) { pos[i * 3u + k] = v; }
  else if (k < 6u) { logScale[i * 3u + k - 3u] = v; }
  else if (k < 10u) { quat[i * 4u + k - 6u] = v; }
  else if (k < 13u) { sh[i * 3u + k - 10u] = v; }
  else { logit[i] = v; }
}

fn load(i: u32, k: u32) -> f32 {
  if (k < 3u) { return pos[i * 3u + k]; }
  if (k < 6u) { return logScale[i * 3u + k - 3u]; }
  if (k < 10u) { return quat[i * 4u + k - 6u]; }
  if (k < 13u) { return sh[i * 3u + k - 10u]; }
  return logit[i];
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i * PARAMS >= arrayLength(&gparam)) { return; }
  for (var k = 0u; k < PARAMS; k++) {
    let at = i * PARAMS + k;
    let g = gparam[at];
    let m = opt.ab.x * mom[at] + (1.0 - opt.ab.x) * g;
    let v = opt.ab.y * vel[at] + (1.0 - opt.ab.y) * g * g;
    mom[at] = m;
    vel[at] = v;
    store(i, k, load(i, k) - rateOf(k) * (m / opt.lr2.y)
      / (sqrt(v / opt.lr2.z) + opt.ab.z));
  }
}
`;

export const CLEAR = `
@group(0) @binding(0) var<storage, read_write> buf: array<u32>;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x < arrayLength(&buf)) { buf[gid.x] = 0u; }
}
`;
