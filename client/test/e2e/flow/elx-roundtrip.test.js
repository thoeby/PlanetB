// @ts-check
// Copied from wireon-process-editor tests/elx-roundtrip.test.js at ab525305d8ddd7dba7a5592e5cb79d3dbb159e8b; changes:
// the modules are imported from /flow/ (this repository's copy of them) and
// the fixtures from /flow/palette and /flow/samples. The assertions are
// untouched — that is the point of running them here.
// Phase 2 — round-trip canary suite (the most important test in the repo).
//
// For every file listed in samples/manifest.json:
//   1. parse(s) -> ir1
//      serialize(ir1) -> s1
//      parse(s1) -> ir2
//      assertEq(ir1, ir2)                        // IR-stable
//   2. serialize(ir2) -> s2
//      assertEq(s1, s2)                          // idempotent output
//
// Adding a new sample is two steps: drop the file in samples/, list it
// in samples/manifest.json. (Browsers can't enumerate a directory over
// fetch; a manifest is the simplest way to stay zero-tool.)

import { parseElx } from "/flow/elx/parse.js";
import { serializeElx } from "/flow/elx/serialize.js";

const g = /** @type {any} */ (window);

/** @param {string} path */
async function fetchText(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error("fetch " + path + " -> " + r.status);
  return await r.text();
}

/** @returns {Promise<string[]>} */
async function loadManifest() {
  const r = await fetch("/flow/samples/manifest.json");
  if (!r.ok) throw new Error("samples/manifest.json missing: " + r.status);
  const j = await r.json();
  if (!Array.isArray(j.files)) throw new Error("manifest.files must be an array");
  return j.files;
}

g.test("round-trip: every sample is IR-stable and idempotent", async () => {
  const files = await loadManifest();
  if (files.length === 0) throw new Error("manifest has no samples");

  /** @type {string[]} */
  const failures = [];
  for (const f of files) {
    const path = "/flow/samples/" + f;
    const src = await fetchText(path);
    const ir1 = parseElx(src);
    const s1 = serializeElx(ir1);
    let ir2;
    try {
      ir2 = parseElx(s1);
    } catch (e) {
      failures.push(f + ": serializer output failed to re-parse: " + (e instanceof Error ? e.message : String(e)));
      continue;
    }
    if (!deepEq(ir1, ir2)) {
      failures.push(f + ": parse(serialize(parse(s))) is not IR-equal to parse(s)\n" + diffSnippet(ir1, ir2));
      continue;
    }
    const s2 = serializeElx(ir2);
    if (s1 !== s2) {
      failures.push(f + ": serialize is not idempotent\n" + stringDiff(s1, s2));
      continue;
    }
  }
  if (failures.length) {
    throw new Error("round-trip failed:\n" + failures.join("\n\n"));
  }
});

g.test("round-trip: serialized output is well-formed XML with <elx> root", async () => {
  const files = await loadManifest();
  for (const f of files) {
    const src = await fetchText("/flow/samples/" + f);
    const out = serializeElx(parseElx(src));
    if (!out.startsWith("<elx>") && !out.startsWith("<elx ")) {
      throw new Error(f + ": output does not begin with <elx>: " + out.slice(0, 40));
    }
    if (!out.endsWith("</elx>\n")) {
      throw new Error(f + ": output does not end with </elx>\\n");
    }
  }
});

g.test("round-trip: CDATA preserved on string values", async () => {
  const src = await fetchText("/flow/samples/file-response.elx");
  const out = serializeElx(parseElx(src));
  // The Target input's value was authored as CDATA; it must round-trip
  // as CDATA, not as a plain text node.
  if (!out.includes("<![CDATA[css/cover.css]]>")) {
    throw new Error("expected CDATA for Target value; got:\n" + extractSnippet(out, "Target"));
  }
  // The boolean parameter on Entries (in create-albumlist) was not
  // CDATA; check it stays plain text. Use the second sample for that.
  const src2 = await fetchText("/flow/samples/create-albumlist.elx");
  const out2 = serializeElx(parseElx(src2));
  if (!/<value id="boolean" plugin="">false<\/value>/.test(out2)) {
    throw new Error("expected plain-text boolean 'false'; sample fragment:\n" + extractSnippet(out2, "recursive"));
  }
});

g.test("round-trip: quirks preserved (invalid structure, error-code value, empty error constant)", async () => {
  const src = await fetchText("/flow/samples/create-albumlist.elx");
  const out = serializeElx(parseElx(src));

  if (!out.includes('<structure id="invalid" plugin=""/>')) {
    throw new Error("invalid-structure sentinel was not preserved verbatim");
  }
  if (!out.includes('<value id="error-code" plugin=""><![CDATA[</td></tr>]]></value>')) {
    throw new Error("mis-tagged <value id=\"error-code\"> was not preserved verbatim");
  }
  if (!out.includes('<constant port="error"/>')) {
    throw new Error("empty <constant port=\"error\"/> was not preserved verbatim");
  }
});

g.test("round-trip: port_group always uses explicit close tag", async () => {
  const src = await fetchText("/flow/samples/create-albumlist.elx");
  const out = serializeElx(parseElx(src));
  // Self-closing port_group would break the server-style match.
  if (/<port_group[^>]*\/>/.test(out)) {
    throw new Error("port_group was emitted self-closed; expected explicit </port_group>");
  }
  if (!out.includes('<port_group id="in" size="3"></port_group>')) {
    throw new Error("OR's port_group(size=3) not emitted with explicit close");
  }
});

// ---------------------------------------------------------------------------
// Helpers — kept in-file rather than adding to the runner globals.
// ---------------------------------------------------------------------------

function deepEq(a, b) {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ak = Object.keys(a), bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  for (const k of ak) if (!deepEq(a[k], b[k])) return false;
  return true;
}

function diffSnippet(a, b) {
  try {
    const sa = JSON.stringify(a);
    const sb = JSON.stringify(b);
    const i = firstDiff(sa, sb);
    return "  first diff at offset " + i +
      "\n    expected: " + sa.slice(Math.max(0, i - 20), i + 60) +
      "\n    got:      " + sb.slice(Math.max(0, i - 20), i + 60);
  } catch (_e) {
    return "  (could not diff)";
  }
}

function stringDiff(a, b) {
  const i = firstDiff(a, b);
  return "  first diff at byte " + i +
    "\n    a: " + JSON.stringify(a.slice(Math.max(0, i - 30), i + 60)) +
    "\n    b: " + JSON.stringify(b.slice(Math.max(0, i - 30), i + 60));
}

function firstDiff(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return n;
}

/** @param {string} text @param {string} marker */
function extractSnippet(text, marker) {
  const i = text.indexOf(marker);
  if (i < 0) return "(marker not found)";
  return text.slice(Math.max(0, i - 80), Math.min(text.length, i + 160));
}
