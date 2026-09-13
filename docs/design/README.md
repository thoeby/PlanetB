# The design

`splatworld-v5.dc.html` is the design of record for the page, with
`chrome5.dc.html` as the chrome every artboard imports — the brand chip, the
position line, the five-stage pipeline, the altimeter up the right-hand edge,
the bar along the bottom, the minimap, the controls line and the legend.

v5 changes two things about the chrome. The bar is a plinth standing on the
bottom edge rather than a strip floating over it, in three groups: you (the
profile chip with your balance, and Wallet), the five surfaces the game is
played through (Place · Catalog · Land · Publish · Work, keys 1–5), and the
small system ones. Sending what you built and approving what came back are one
job, so Submit and Permission are two tabs of one surface, Publish; the render
pool is Work. And the altimeter is new: height is the one number walking never
tells you and flying is nothing but.

`splatworld-v4.dc.html` (with `chrome4.dc.html`) is the turn before it, and
holds the artboards v5 does not redraw — Land, Place, Catalog, Setup, Admin,
Wallet, Share. `splatworld-v3.dc.html` and `chrome3.dc.html` are the turn the
first build was taken from, kept because the panel components still carry its
numbering (design 3a…3k).

They are Claude Design canvas files. Opening them in a browser needs that
canvas runtime (`support.js`, not vendored here); read as text they are plain
HTML with inline styles, which is how the implementation was taken from them.

Where each part of the design lives:

| design | code |
|---|---|
| colours, type, chamfers, the chrome | `client/hud.css` |
| the house styles a panel's contents inherit | `client/panel.css` |
| the bar's groups, keys and icons | `client/js/tabbar.js` |
| the bar and the altimeter's look | `client/bar.css` |
| the altimeter's arithmetic | `client/js/altimeter.js` |
| the frame, the five stages, the panel and its tabs | `client/js/hud.js` |
| the map in the corner | `client/js/hudmap.js` |
| the panels themselves | `client/js/{land,build,pool,permission,wallet,…}ui.js` |

`../SPEC.md` is the product specification the design serves. Where the two
differ the design is newer — it says so in its own first line ("turn 3 ·
refined against the build"). Two places where this build deliberately differs
from both, because it went further: a rendered tile is a **candidate** that a
person approves (the spec has approval before rendering), and land is drawn in
QGIS rather than assigned by an admin.
