// @ts-check
// Copied from wireon-process-editor tests/plugin-registry.test.js at ab525305d8ddd7dba7a5592e5cb79d3dbb159e8b; changes:
// the modules are imported from /flow/ (this repository's copy of them) and
// the fixtures from /flow/palette and /flow/samples. The assertions are
// untouched — that is the point of running them here.
// Phase 4 — block registry tests.

import { parsePlugin } from "/flow/plugins/parse.js";
import {
  registerPlugin,
  getBlock,
  allBlocks,
  allPlugins,
  byGroup,
  clear,
} from "/flow/plugins/registry.js";

const g = /** @type {any} */ (window);

/** @param {string} path */
async function fetchText(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error("fetch " + path + " -> " + r.status);
  return await r.text();
}

/**
 * Build a small synthetic plugin so tests don't depend on the exact
 * shape of the real plugin XMLs evolving over time.
 *
 * @returns {import("/flow/plugins/parse.js").PluginDef}
 */
function makeFixturePlugin() {
  return {
    id: "fx",
    name: "Fixture",
    blocks: [
      {
        id: "root-block",
        plugin: "fx",
        groupPath: [],
        name: "Root Block",
        descriptions: {},
        parameters: [],
        inputs: [],
        outputs: [],
      },
    ],
    groups: [
      {
        id: "g1",
        name: "Group One",
        blocks: [
          {
            id: "a",
            plugin: "fx",
            groupPath: ["g1"],
            name: "A",
            descriptions: {},
            parameters: [],
            inputs: [],
            outputs: [],
          },
        ],
        groups: [
          {
            id: "g1a",
            name: "G1A",
            blocks: [
              {
                id: "deep",
                plugin: "fx",
                groupPath: ["g1", "g1a"],
                name: "Deep",
                descriptions: {},
                parameters: [],
                inputs: [],
                outputs: [],
              },
            ],
            groups: [],
          },
        ],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Registration & lookup
// ---------------------------------------------------------------------------

g.test("registry: registerPlugin indexes nested blocks for O(1) lookup", () => {
  clear();
  registerPlugin(makeFixturePlugin());

  g.assertEq(allPlugins().length, 1, "one plugin registered");
  g.assertEq(allBlocks().length, 3, "root + nested blocks flattened");

  // Lookups use ELX flat form: groupPath dot-joined + leaf id.
  const root = getBlock("fx", "root-block");
  g.assertEq(root?.name, "Root Block", "root block hit");
  const a = getBlock("fx", "g1.a");
  g.assertEq(a?.groupPath, ["g1"], "nested block carries groupPath");
  const deep = getBlock("fx", "g1.g1a.deep");
  g.assertEq(deep?.groupPath, ["g1", "g1a"], "deeply nested block hit");
});

g.test("registry: getBlock returns null for misses", () => {
  clear();
  registerPlugin(makeFixturePlugin());
  g.assertEq(getBlock("fx", "no-such-block"), null, "unknown block id");
  g.assertEq(getBlock("no-such-plugin", "root-block"), null, "unknown plugin id");
  // Wrong dotted form misses too: leaf id alone shouldn't match a nested block.
  g.assertEq(getBlock("fx", "a"), null, "leaf-only id is not the ELX form");
});

g.test("registry: re-registering a plugin evicts its old blocks", () => {
  clear();
  registerPlugin(makeFixturePlugin());
  g.assertEq(getBlock("fx", "g1.a")?.name, "A", "block 'g1.a' registered first");

  // Re-register with only the root block; "g1.a" and "g1.g1a.deep" should be gone.
  registerPlugin({
    id: "fx",
    name: "Fixture v2",
    blocks: [
      {
        id: "root-block",
        plugin: "fx",
        groupPath: [],
        name: "Root Block v2",
        descriptions: {},
        parameters: [],
        inputs: [],
        outputs: [],
      },
    ],
    groups: [],
  });

  g.assertEq(allBlocks().length, 1, "old blocks evicted on re-registration");
  g.assertEq(getBlock("fx", "g1.a"), null, "evicted block returns null");
  g.assertEq(getBlock("fx", "root-block")?.name, "Root Block v2", "block updated");
});

g.test("registry: clear empties everything", () => {
  clear();
  registerPlugin(makeFixturePlugin());
  clear();
  g.assertEq(allPlugins().length, 0);
  g.assertEq(allBlocks().length, 0);
  g.assertEq(getBlock("fx", "root-block"), null);
});

// ---------------------------------------------------------------------------
// byGroup
// ---------------------------------------------------------------------------

g.test("registry: byGroup keys blocks by 'plugin[/group]*' path", () => {
  clear();
  registerPlugin(makeFixturePlugin());
  const groups = byGroup();

  g.assertEq(
    groups.get("fx")?.map((/** @type {any} */ b) => b.id),
    ["root-block"],
    "root path"
  );
  g.assertEq(
    groups.get("fx/g1")?.map((/** @type {any} */ b) => b.id),
    ["a"],
    "single-level group path"
  );
  g.assertEq(
    groups.get("fx/g1/g1a")?.map((/** @type {any} */ b) => b.id),
    ["deep"],
    "nested group path"
  );
});

g.test("registry: byGroup separates buckets across plugins", () => {
  clear();
  registerPlugin(makeFixturePlugin());
  registerPlugin({
    id: "other",
    name: "Other",
    blocks: [
      {
        id: "x",
        plugin: "other",
        groupPath: [],
        name: "X",
        descriptions: {},
        parameters: [],
        inputs: [],
        outputs: [],
      },
    ],
    groups: [],
  });
  const groups = byGroup();
  g.assertEq(groups.get("fx")?.length, 1);
  g.assertEq(groups.get("other")?.length, 1);
});

// ---------------------------------------------------------------------------
// End-to-end with real plugin XML
// ---------------------------------------------------------------------------

g.test("registry: round-trips the json plugin from XML", async () => {
  clear();
  const def = parsePlugin(await fetchText("/flow/palette/plugins/json/plugin.xml"));
  registerPlugin(def);

  // 7 top-level + 4 in `array` group = 11
  g.assertEq(allBlocks().length, 11, "all json blocks indexed");

  const tr = getBlock("json", "template-render");
  g.assertEq(tr?.name, "Render Template", "ELX-style (plugin, id) lookup");

  const append = getBlock("json", "array.append");
  g.assertEq(append?.groupPath, ["array"], "nested block reached via dotted id");

  const groups = byGroup();
  g.assertEq(groups.get("json")?.length, 7, "json palette root size");
  g.assertEq(groups.get("json/array")?.length, 4, "json/array palette size");
});
