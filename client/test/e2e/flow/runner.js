// @ts-check
// Minimal in-page test runner. Loaded as a classic script so its
// helpers are global to subsequent test scripts.

(function attach(global) {
  /** @type {{ name: string, fn: () => unknown | Promise<unknown> }[]} */
  const tests = [];

  function test(name, fn) {
    tests.push({ name, fn });
  }

  function deepEq(a, b) {
    if (Object.is(a, b)) return true;
    if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    const ak = Object.keys(a), bk = Object.keys(b);
    if (ak.length !== bk.length) return false;
    for (const k of ak) if (!deepEq(a[k], b[k])) return false;
    return true;
  }

  function assertEq(actual, expected, msg) {
    if (!deepEq(actual, expected)) {
      throw new Error(
        (msg ? msg + ": " : "assertEq failed: ") +
          "expected " + JSON.stringify(expected) +
          ", got " + JSON.stringify(actual)
      );
    }
  }

  function assertThrows(fn, msg) {
    let threw = false;
    try { fn(); } catch (_e) { threw = true; }
    if (!threw) throw new Error((msg || "assertThrows") + ": function did not throw");
  }

  async function runAllTests() {
    const root = document.body;
    const list = document.createElement("ul");
    list.id = "results";
    root.appendChild(list);

    let passed = 0, failed = 0;
    for (const t of tests) {
      const li = document.createElement("li");
      try {
        await t.fn();
        li.textContent = "PASS  " + t.name;
        li.style.color = "#0a0";
        passed++;
      } catch (e) {
        const err = /** @type {Error} */ (e);
        li.textContent = "FAIL  " + t.name + " — " + (err && err.message ? err.message : String(e));
        li.style.color = "#c00";
        failed++;
      }
      list.appendChild(li);
    }

    const summary = document.createElement("p");
    summary.id = "summary";
    summary.textContent = passed + " passed, " + failed + " failed";
    summary.style.fontWeight = "bold";
    root.insertBefore(summary, list);
    return { passed, failed };
  }

  global.test = test;
  global.assertEq = assertEq;
  global.assertThrows = assertThrows;
  global.runAllTests = runAllTests;
})(/** @type {any} */ (window));
