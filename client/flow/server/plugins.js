// @ts-check
// plugins.js — putting a plugin on a process server (TASKS-live.md LV.7).
//
// A plugin bought in the catalog is a folder, stored as its canonical tar
// (client/lib/plugintar.js). Installing it is the buyer's own tab sending that
// tar to the chosen server's plugin path; the world is not asked and not told
// (Invariant 9). The reference server's route for this is not written down
// anywhere (docs/flow.md): `POST /system/plugins/install?id=` with the tar is
// what this page sends and what tools/elx-fixture.py answers, and the first
// real server settles it — the refusal is said in its own words until then.

import { serverClient } from "./client.js";

/**
 * @param {string} url      the server's address
 * @param {string} id       the plugin's id, as its plugin.xml says it
 * @param {Uint8Array} tar  the canonical tar
 */
export async function installPlugin(url, id, tar) {
  const server = serverClient(url);
  await server.request("POST", "/system/plugins/install",
    { query: { id }, body: tar, type: "application/x-tar" });
  return id;
}
