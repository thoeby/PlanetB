// opfs.js — a directory of files in the tab's own origin-private file system.
//
// brush (client/lib/brush.js) reads its dataset from a
// FileSystemDirectoryHandle and nothing else; a Worker can make one without
// asking anybody by writing into OPFS. The directory is scratch: written for
// one atom, removed when it is done.

export async function datasetDir(name, files, storage = navigator.storage) {
    const root = await storage.getDirectory();
    await root.removeEntry(name, { recursive: true }).catch(() => {});
    const dir = await root.getDirectoryHandle(name, { create: true });
    for (const f of files) {
        const handle = await dir.getFileHandle(f.name, { create: true });
        const w = await handle.createWritable();
        await w.write(f.bytes);
        await w.close();
    }
    return dir;
}

export async function removeDir(name, storage = navigator.storage) {
    const root = await storage.getDirectory();
    await root.removeEntry(name, { recursive: true }).catch(() => {});
}

// One file kept in the tab's own storage, under a path of directories: what
// a player shaped and could not save (client/js/shapekeep.js, EDT.10), which
// must survive a reload. Nothing here is scratch.
async function dirOf(path, storage, create) {
    let dir = await storage.getDirectory();
    for (const part of path) dir = await dir.getDirectoryHandle(part, { create });
    return dir;
}

export async function keepFile(path, name, bytes, storage = navigator.storage) {
    const dir = await dirOf(path, storage, true);
    const handle = await dir.getFileHandle(name, { create: true });
    const w = await handle.createWritable();
    await w.write(bytes);
    await w.close();
}

export async function readKept(path, name, storage = navigator.storage) {
    try {
        const dir = await dirOf(path, storage, false);
        const file = await (await dir.getFileHandle(name)).getFile();
        return new Uint8Array(await file.arrayBuffer());
    } catch {
        return null;
    }
}

export async function dropKept(path, name, storage = navigator.storage) {
    try {
        const dir = await dirOf(path, storage, false);
        await dir.removeEntry(name);
    } catch { /* nothing kept */ }
}
