# The design

`splatworld-v3.dc.html` is the design of record for the page: eleven artboards
at 1920 × 1080, one per surface, over a screenshot of the world.
`chrome3.dc.html` is the chrome they all import — the brand chip, the position
line, the five-stage pipeline, credits, the hotbar, the minimap, the controls
line and the legend.

They are Claude Design canvas files. Opening them in a browser needs that
canvas runtime (`support.js`, not vendored here); read as text they are plain
HTML with inline styles, which is how the implementation was taken from them.

Where each part of the design lives:

| design | code |
|---|---|
| colours, type, chamfers, the chrome | `client/hud.css` |
| the house styles a panel's contents inherit | `client/panel.css` |
| the hotbar's groups, keys and glyphs; the five stages | `client/js/hud.js` |
| the map in the corner | `client/js/hudmap.js` |
| the panels themselves | `client/js/{land,build,pool,permission,wallet,…}ui.js` |

`../SPEC.md` is the product specification the design serves. Where the two
differ the design is newer — it says so in its own first line ("turn 3 ·
refined against the build"). Two places where this build deliberately differs
from both, because it went further: a rendered tile is a **candidate** that a
person approves (the spec has approval before rendering), and land is drawn in
QGIS rather than assigned by an admin.
