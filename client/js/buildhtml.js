// buildhtml.js — the Place panel's markup (design 3c), kept apart from
// buildui.js so both stay under the 400 lines CLAUDE.md allows.

// The artboard's order (design 3c): whether you are building, where you are,
// what to pick, what is selected, then the three ways to move it — with the
// axis, the step and the snap on the same line as the design puts them — and
// last what is placed but not yet submitted.
export const HTML = `
<div class="row-switch build-on">
  <span>Build mode · click the ground to drop · Esc to leave</span>
  <input type="checkbox" class="build-toggle">
</div>
<div class="build-where note"></div>

<div class="section">
  <span class="label">Pick</span>
  <input class="build-search" type="search"
    placeholder="Search the catalog to pick a product…">
  <ul class="build-assets rows"></ul>
</div>

<div class="section">
  <span class="label">Selected</span>
  <div class="build-sel note">Nothing selected — click something you may edit.</div>
  <div class="build-gizmo row">
    <button type="button" data-mode="move">Move <span class="key">G</span></button>
    <button type="button" data-mode="turn">Turn <span class="key">R</span></button>
    <button type="button" data-mode="size">Size <span class="key">T</span></button>
  </div>
  <div class="build-gizmo row">
    <button type="button" data-axis="x">X</button>
    <button type="button" data-axis="y">Up</button>
    <button type="button" data-axis="z">Z</button>
    <button type="button" class="build-less">&minus;</button>
    <span class="build-step mono">step</span>
    <button type="button" class="build-more">+</button>
  </div>
  <label class="build-snap row-switch">
    <span>Snap to the step</span>
    <input type="checkbox" class="build-snap-on" checked>
  </label>
  <div class="build-acts row">
    <button type="button" class="build-del">Delete</button>
    <button type="button" class="build-undo">Undo</button>
  </div>
</div>

<div class="section">
  <span class="label">Placed, not yet submitted</span>
  <div class="note">Only you see these until the land is submitted and
    rendered.</div>
  <ul class="build-tiles rows"></ul>
</div>`;
