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

// The air: how far you see before the haze takes half the contrast.
export const VISIBILITY_M = 18000;
// The horizon: the sky's colour desaturated and lightened by the air.
export const HORIZON = [0.74, 0.80, 0.88];
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
void main() {
    vec3 d = normalize(vDir);
    float up = clamp(d.y, 0.0, 1.0);
    // The sky thickens towards the horizon; the ground below it is the haze.
    vec3 sky = mix(uHorizon, uZenith, pow(up, 0.55));
    float s = max(dot(d, uSun), 0.0);
    vec3 glow = vec3(1.0, 0.95, 0.85) * (pow(s, 600.0) * 1.2 + pow(s, 8.0) * 0.10);
    vec3 c = d.y < 0.0 ? mix(uHorizon, uHorizon * 0.85, clamp(-d.y * 3.0, 0.0, 1.0)) : sky + glow;
    gl_FragColor = vec4(c, 1.0);
}`;

// The dome follows the camera; `follow(p)` each frame with its position.
export function mountSky(app, pc, camera) {
    const device = app.graphicsDevice;
    const material = new pc.ShaderMaterial({
        uniqueName: 'splatworld-sky',
        attributes: { vertex_position: pc.SEMANTIC_POSITION },
        vertexGLSL: VERT,
        fragmentGLSL: FRAG,
    });
    material.cull = pc.CULLFACE_FRONT;
    material.depthWrite = false;
    material.depthTest = false;
    material.setParameter('uZenith', ZENITH);
    material.setParameter('uHorizon', HORIZON);
    material.setParameter('uSun', SUN);
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
    camera.camera.clearColor = new pc.Color(...HORIZON);

    const fog = app.scene.fog;
    fog.type = pc.FOG_EXP2;
    fog.color = new pc.Color(...HORIZON);
    // exp2: transmittance e^-(d·x)²; half the contrast at VISIBILITY_M.
    fog.density = Math.sqrt(Math.LN2) / VISIBILITY_M;

    return {
        follow(p) { dome.setPosition(p.x, p.y, p.z); },
    };
}
