// draco.js — KHR_draco_mesh_compression, undone.
//
// canon-v1 keeps no extension but KHR_materials_*, and a compressed mesh is not
// a material: it is the geometry, in a form the canon cannot sort or compare.
// So it is decoded back to plain accessors before anything else looks at the
// file, and the extension is dropped with the rest.
//
// The decoder is Google's (Apache-2.0), vendored by `make vendor` rather than
// reimplemented. Nothing here decides anything: `decode` is injected, so a page
// with no decoder refuses the upload instead of producing a second, wrong
// canonical form.

import { viewBytes } from './glb.js';

const EXT = 'KHR_draco_mesh_compression';

export const hasDraco = (gltf) => (gltf.meshes ?? []).some(
    (mesh) => mesh.primitives.some((p) => p.extensions?.[EXT]));

// Appends `data` as its own buffer, view and accessor, and answers the index.
function append(gltf, buffers, data, type, componentType, components) {
    const u8 = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    buffers.push(u8);
    gltf.buffers = gltf.buffers ?? [];
    gltf.buffers.push({ byteLength: u8.byteLength });
    gltf.bufferViews.push({ buffer: buffers.length - 1, byteOffset: 0,
        byteLength: u8.byteLength });
    gltf.accessors.push({ bufferView: gltf.bufferViews.length - 1, componentType,
        count: data.length / components, type });
    return gltf.accessors.length - 1;
}

const TYPE_OF = { 1: 'SCALAR', 2: 'VEC2', 3: 'VEC3', 4: 'VEC4' };

export async function inflateDraco(gltf, buffers, decode) {
    if (!hasDraco(gltf)) {
        strip(gltf);
        return;
    }
    if (!decode) {
        throw new Error('this GLB is Draco-compressed and no decoder is available');
    }
    for (const mesh of gltf.meshes) {
        for (const prim of mesh.primitives) {
            const ext = prim.extensions?.[EXT];
            if (ext) await inflateOne(gltf, buffers, prim, ext, decode);
        }
    }
    strip(gltf);
}

async function inflateOne(gltf, buffers, prim, ext, decode) {
    const out = await decode(viewBytes(gltf, buffers, ext.bufferView), ext.attributes);
    for (const [name, values] of Object.entries(out.attributes)) {
        if (prim.attributes[name] === undefined) continue;
        const components = values.length / out.points;
        prim.attributes[name] = append(gltf, buffers, values,
            TYPE_OF[components], 5126, components);
    }
    prim.indices = append(gltf, buffers, out.indices, 'SCALAR', 5125, 1);
    delete prim.extensions[EXT];
}

function strip(gltf) {
    for (const mesh of gltf.meshes ?? []) {
        for (const prim of mesh.primitives) {
            if (prim.extensions && !Object.keys(prim.extensions).length) delete prim.extensions;
        }
    }
    for (const key of ['extensionsUsed', 'extensionsRequired']) {
        if (gltf[key]) gltf[key] = gltf[key].filter((n) => n !== EXT);
    }
}

// ------------------------------------------------------------------- decoder

// Adapts a draco3d decoder module — `createDecoderModule()` from the vendored
// package — to the `decode(bytes, attributes)` this file wants.
export function dracoDecode(draco) {
    return (bytes, attributes) => {
        const decoder = new draco.Decoder();
        const buffer = new draco.DecoderBuffer();
        buffer.Init(bytes, bytes.length);
        const mesh = new draco.Mesh();
        const status = decoder.DecodeBufferToMesh(buffer, mesh);
        if (!status.ok() || mesh.ptr === 0) throw new Error(`draco: ${status.error_msg()}`);
        const out = { points: mesh.num_points(), indices: indicesOf(draco, decoder, mesh),
            attributes: {} };
        for (const [name, id] of Object.entries(attributes)) {
            out.attributes[name] = floatsOf(draco, decoder, mesh, id);
        }
        draco.destroy(mesh);
        draco.destroy(buffer);
        draco.destroy(decoder);
        return out;
    };
}

function indicesOf(draco, decoder, mesh) {
    const faces = mesh.num_faces();
    const ptr = draco._malloc(faces * 12);
    decoder.GetTrianglesUInt32Array(mesh, faces * 12, ptr);
    const out = new Uint32Array(draco.HEAPU32.buffer, ptr, faces * 3).slice();
    draco._free(ptr);
    return out;
}

function floatsOf(draco, decoder, mesh, uniqueId) {
    const attr = decoder.GetAttributeByUniqueId(mesh, uniqueId);
    const values = new draco.DracoFloat32Array();
    decoder.GetAttributeFloatForAllPoints(mesh, attr, values);
    const out = new Float32Array(values.size());
    for (let i = 0; i < out.length; i++) out[i] = values.GetValue(i);
    draco.destroy(values);
    return out;
}
