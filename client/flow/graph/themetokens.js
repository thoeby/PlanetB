// @ts-check
// Copied from wireon-process-editor src/graph/theme.js at ab525305d8ddd7dba7a5592e5cb79d3dbb159e8b; changes:
// theme.js was 518 lines, over this repository's 400-line rule, so it is three
// files here — the palette (this one), the install (theme.js) and the drawing
// (themedraw.js). The palette itself is the restyle FND.1 asks for: the
// reference editor is black on white, the world's chrome is hud.css, so every
// colour is read from the page's own custom properties (--ink, --edge,
// --panel-solid, --accent, --mono) and nothing else is named here.

/**
 * What the page says the chrome is drawn in. Read once per call rather than
 * cached, because the accent follows the view: Automate's hue is set on #hud
 * when the app is switched (client/js/hud.js dressFor).
 *
 * @param {{ name: string, fallback: string }} token
 * @returns {string}
 */
function cssToken(token) {
  try {
    const host = document.querySelector("#hud") || document.documentElement;
    const v = getComputedStyle(host).getPropertyValue(token.name).trim();
    return v || token.fallback;
  } catch {
    return token.fallback;
  }
}

/** The palette, as the page has it this moment. */
export function palette() {
  return {
    /** Lines, text, ports: the chrome's ink. */
    fg: cssToken({ name: "--ink", fallback: "#f2efe8" }),
    /** The canvas and a node's body: the chrome's panel. */
    bg: cssToken({ name: "--panel-solid", fallback: "rgba(14, 16, 20, 0.95)" }),
    /** A node's title bar and a selected border: the view's hue. */
    accent: cssToken({ name: "--accent", fallback: "oklch(0.8 0.14 290)" }),
    /** Anything that is structure rather than content. */
    edge: cssToken({ name: "--edge", fallback: "rgba(255, 255, 255, 0.12)" }),
    /** Text drawn on the accent. */
    on: cssToken({ name: "--ground", fallback: "#0b0d10" }),
    /** Values are monospace, everywhere in this world. */
    mono: cssToken({ name: "--mono", fallback: "ui-monospace, Menlo, monospace" }),
    head: cssToken({ name: "--head", fallback: "'Rajdhani', sans-serif" }),
  };
}

/** Per-design-rule constants. Unchanged from the reference editor. */
export const TITLE_HEIGHT = 22;
export const TITLE_PAD_LEFT = 12;
export const PORT_SIZE = 10;
export const PORT_HOVER_SIZE = 12;
export const SELECT_BORDER_WIDTH = 3;
export const WIRE_WIDTH = 2;
export const HATCH_STEP = 4;

/** The two fonts, built from the page's families at the reference's sizes. */
export const titleFont = () => `600 13px ${palette().head}`;
export const slotFont = () => `500 12px ${palette().mono}`;
