// sky.js — the sky and the air, in the viewer.
//
// The splats are the ground as it is; the sky and the distance are the
// viewer's, drawn here and never trained into a tile (a splat is seen from
// everywhere, and haze is a property of the view, not the surface). Two
// pieces: a dome around the camera with the one sky of client/lib/light.js on
// it — blue at the zenith, pale at the horizon, a glow round the sun — and
// exponential fog in the sky's horizon colour over everything the engine
// draws, splats included (PlayCanvas's gsplat renderer takes the scene fog).
//
// Plain scattering-by-distance for now: the same air whether you stand in the
// valley or on the ridge. A height-aware model (Lague's planet atmosphere) is
// a fog chunk away, and would go here.

import { SKY_COLOUR, SUN } from '../lib/light.js';

// The air: how far you see before the haze takes half the contrast. 6 km put
// a wall of haze on a ridge a kilometre off — the operator's word was "too
// dense". A clear alpine day sees fifty kilometres or more; 25 km keeps the
// far ranges hazed and the valley in front of you sharp.
export const VISIBILITY_M = 25000;
// The horizon: the sky's colour desaturated and lightened by the air.
export const HORIZON = [0.74, 0.80, 0.88];
// What is under the world. The dome used to paint haze below the horizon
// too, so every hole in a tile — its edge, a slope nobody framed, ground
// not yet rendered — was a bright blue window into nothing, the one thing
// that reads as broken from every angle. Below a thin band of haze at the
// horizon the dome is dark now, so a hole reads as shadow.
export const UNDERWORLD = [0.06, 0.065, 0.075];
export const ZENITH = SKY_COLOUR.map((c) => c * 0.75);

const VERT = `
attribute vec3 vertex_position;
uniform mat4 matrix_model;
uniform mat4 matrix_viewProjection;
varying vec3 vDir;
void main() {
    vec4 world = matrix_model * vec4(vertex_position, 1.0);
    vDir = vertex_position;
    gl_Position = matrix_viewProjection * world;
    // On the far plane, behind everything.
    gl_Position.z = gl_Position.w * 0.999999;
}`;

const FRAG = `
precision highp float;
varying vec3 vDir;
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uSun;
uniform vec3 uUnder;
void main() {
    vec3 d = normalize(vDir);
    float up = clamp(d.y, 0.0, 1.0);
    // The sky thickens towards the horizon; the ground below it is the haze.
    vec3 sky = mix(uHorizon, uZenith, pow(up, 0.55));
    float s = max(dot(d, uSun), 0.0);
    vec3 glow = vec3(1.0, 0.95, 0.85) * (pow(s, 600.0) * 1.2 + pow(s, 8.0) * 0.10);
    vec3 c = d.y < 0.0 ? mix(uHorizon, uUnder, clamp(-d.y * 12.0, 0.0, 1.0)) : sky + glow;
    gl_FragColor = vec4(c, 1.0);
}`;

// The same dome in WGSL. PlayCanvas runs on WebGPU wherever the browser has
// it, and a GLSL-only ShaderMaterial there is a sky that never draws: the page
// was left with the clear colour and nothing else, which is what "no sky"
// looked like. Conventions are the engine's own (its scripts/esm/grid.mjs):
// attributes and varyings declared by name, uniforms read off `uniform`.
const VERT_WGSL = `
attribute vertex_position: vec3f;
uniform matrix_model: mat4x4f;
uniform matrix_viewProjection: mat4x4f;
varying vDir: vec3f;
@vertex
fn vertexMain(input: VertexInput) -> VertexOutput {
    var output: VertexOutput;
    let world = uniform.matrix_model * vec4f(input.vertex_position, 1.0);
    output.vDir = input.vertex_position;
    var p = uniform.matrix_viewProjection * world;
    // On the far plane, behind everything.
    p.z = p.w * 0.999999;
    output.position = p;
    return output;
}`;

const FRAG_WGSL = `
uniform uZenith: vec3f;
uniform uHorizon: vec3f;
uniform uSun: vec3f;
uniform uUnder: vec3f;
varying vDir: vec3f;
@fragment
fn fragmentMain(input: FragmentInput) -> FragmentOutput {
    var output: FragmentOutput;
    let d = normalize(input.vDir);
    let up = clamp(d.y, 0.0, 1.0);
    // The sky thickens towards the horizon; the ground below it is the haze.
    let sky = mix(uniform.uHorizon, uniform.uZenith, pow(up, 0.55));
    let s = max(dot(d, uniform.uSun), 0.0);
    let glow = vec3f(1.0, 0.95, 0.85) * (pow(s, 600.0) * 1.2 + pow(s, 8.0) * 0.10);
    var c = sky + glow;
    if (d.y < 0.0) {
        c = mix(uniform.uHorizon, uniform.uUnder, clamp(-d.y * 12.0, 0.0, 1.0));
    }
    output.color = vec4f(c, 1.0);
    return output;
}`;

// The dome follows the camera; `follow(p)` each frame with its position.
export function mountSky(app, pc, camera) {
    const device = app.graphicsDevice;
    camera.camera.clearColor = new pc.Color(...HORIZON);
    const fog = app.scene.fog;
    fog.type = pc.FOG_EXP2;
    fog.color = new pc.Color(...HORIZON);
    // exp2: transmittance e^-(d·x)²; half the contrast at VISIBILITY_M.
    fog.density = Math.sqrt(Math.LN2) / VISIBILITY_M;
    const material = new pc.ShaderMaterial({
        uniqueName: 'splatworld-sky',
        attributes: { vertex_position: pc.SEMANTIC_POSITION },
        vertexGLSL: VERT,
        fragmentGLSL: FRAG,
        vertexWGSL: VERT_WGSL,
        fragmentWGSL: FRAG_WGSL,
    });
    material.cull = pc.CULLFACE_FRONT;
    material.depthWrite = false;
    // The vertex shader puts the dome on the far plane, and the depth test is
    // what keeps it there: the skybox pass runs after the opaque world, so a
    // dome that skipped the test was painted over every opaque thing in the
    // scene — the ground where nothing is published, a placed model — and
    // only the splats, drawn later, showed through it.
    material.depthTest = true;
    material.depthFunc = pc.FUNC_LESSEQUAL;
    material.setParameter('uZenith', ZENITH);
    material.setParameter('uHorizon', HORIZON);
    material.setParameter('uSun', SUN);
    material.setParameter('uUnder', UNDERWORLD);
    material.update();
    const mesh = pc.Mesh.fromGeometry(device,
        new pc.SphereGeometry({ radius: 1, latitudeBands: 24, longitudeBands: 32 }));
    const dome = new pc.Entity('sky');
    dome.addComponent('render', {
        meshInstances: [new pc.MeshInstance(mesh, material)],
        layers: [pc.LAYERID_SKYBOX],
        castShadows: false,
        receiveShadows: false,
    });
    dome.setLocalScale(1e6, 1e6, 1e6);
    app.root.addChild(dome);
    return {
        follow(p) { dome.setPosition(p.x, p.y, p.z); },
    };
}
