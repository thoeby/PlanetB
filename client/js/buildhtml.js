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
    placeholder="Find a product to place…">
  <ul class="build-assets rows"></ul>
  <p class="build-hint note"></p>
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
    <button type="button" class="build-save primary">Save</button>
  </div>
  <p class="build-saved status"></p>
</div>

<div class="section build-ports-section" hidden>
  <span class="label">Ports</span>
  <div class="note">What this thing can be told. A switch takes at once;
    a screen is shown to others after the land's approver says yes.</div>
  <ul class="build-ports rows"></ul>
  <p class="build-ports-said status"></p>
</div>

<div class="section build-flows-section" hidden>
  <div class="build-flows-head"><span class="label">Flows</span>
    <span class="build-flows-count"></span></div>
  <ul class="build-flows rows"></ul>
  <div class="build-flows-acts row"></div>
  <p class="build-flows-said status"></p>
</div>

<div class="section build-movers-section">
  <span class="label">Movers</span>
  <div class="note">A bus is not on the land, it moves over it: nothing here is
    compiled and nobody approves it. Everybody sees it in the same place at the
    same second, because everybody reads the world's own clock.</div>
  <ul class="mv-list rows"></ul>
  <div class="row">
    <input class="mv-name" type="text" placeholder="Bus 1">
    <input class="mv-search" type="search" placeholder="which product…">
  </div>
  <ul class="mv-found rows"></ul>
  <div class="row">
    <button type="button" class="mv-draw">Draw the route</button>
    <span class="mv-route note"></span>
  </div>
  <div class="row">
    <label class="mv-field">km/h <input class="mv-speed" type="number" value="30"></label>
    <label class="mv-field">every N min <input class="mv-every" type="number" value="5"></label>
  </div>
  <div class="row">
    <label class="mv-field">stop at m <input class="mv-stop-at" type="number" value="0"></label>
    <label class="mv-field">for s <input class="mv-stop-s" type="number" value="0"></label>
    <label class="mv-field row-switch">back and forth
      <input class="mv-back" type="checkbox"></label>
  </div>
  <div class="row">
    <button type="button" class="mv-make primary">Put it on the route</button>
  </div>
  <p class="mv-said status"></p>
</div>

<div class="section">
  <span class="label">Placed, not yet submitted</span>
  <div class="note">Saved objects are on the land for everyone, marked "not yet
    rendered", until the land is submitted and somebody compiles it.</div>
  <ul class="build-tiles rows"></ul>
</div>`;
