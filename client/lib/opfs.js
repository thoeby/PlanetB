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
