# The design

`splatworld-v8.dc.html` is the design of record for the Work window — five
tabs, a card for every job, and a card opened — on the `chrome7.dc.html`
chrome; `splatworld-v7.dc.html` is the turn before it, which adds a seventh
view and four parts inside Build that are not built yet.

`splatworld-v6.dc.html` is the design of record for the rest of the page, with
`chrome6.dc.html` as the chrome every artboard imports — the strip along the
top, the position line, the altimeter up the right-hand edge, the plinth along
the bottom, the minimap, the controls panel and the legend.

v6 moves everything that is not the game itself into one 44 px strip along the
top: the apps button (Tab) and the apps drawer, the wordmark, every app as a
glyph with only the one you are in named in its own hue, and, on the right, the
two numbers Build is played by (what is rendered, what is waiting for a
person), the clock, your balance, the bell and you. A notification lands under
the bell for eight seconds and the tray keeps it. The plinth along the bottom
is then just the five surfaces the game is played through, and what used to be
a small button of its own is a tab of one of the three the strip carries:
Share is part of Profile, and Setup and the two admin tools are parts of
Settings. The controls are a panel above the map, with the movement mode at
the head of it and the keys as caps.

An app is a workspace over the same world, the way Blender's are: the bar, the
panels and the instruments change, where you stand does not. Build is the one
this repository implements; the other five switch the chrome and say on their
own card that they are not wired yet. Build stays cyan.

**The six are now named for what they are played for** (SPEC §2.1 Views, the
operator's decision, and the one place the build departs from chrome6's
artboard): Build · Automate · Work · Trade & Sell · Play · Survey. Drive,
Photo and Tour are one view, Play; Render is Work; the catalog both ways is
Trade & Sell; Automate is the flow editor. The glyphs, hues and the drawer are
the artboard's; only the names, the keys behind them and Automate's glyph are
ours.

**Two things are ours rather than the mockup's**, and v6 does not move them:
the compass is ruled — a tick every 15°, tall and lit where a point is named —
and it stays under the strip rather than inside it, and the altimeter keeps the
ladder, the ground line and the pitch gutter it has. Both read the camera.

v5, the turn before it, changed two things about the chrome. The bar became a
plinth standing on the bottom edge rather than a strip floating over it, in
three groups: you (the profile chip with your balance, and Wallet), the five
surfaces the game is played through (Place · Catalog · Land · Publish · Work,
keys 1–5), and the small system ones — the three groups v6 reduced to one.
Sending what you built and approving what came back are one job, so Submit and
Permission are two tabs of one surface, Publish; the render pool is Work. And
the altimeter is new: height is the one number walking never tells you and
flying is nothing but.

`splatworld-v4.dc.html` (with `chrome4.dc.html`) is the turn before that, and
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
| the strip along the top, the apps drawer, the notifications | `client/top.css` |
| the views, and what each is for | `client/js/apps.js` |
| the strip's cells: apps, numbers, clock, wallet, bell, you | `client/js/topbar.js` |
| a notification's eight seconds, and the tray after them | `client/js/notify.js` |
| the house styles a panel's contents inherit | `client/panel.css` |
| every surface there is, its key, its icon and where it opens from | `client/js/tabbar.js` |
| the bar and the altimeter's look | `client/bar.css` |
| the altimeter's arithmetic | `client/js/altimeter.js` |
| the frame, the panel and its tabs, the app the chrome is dressed for | `client/js/hud.js` |
| the map in the corner, and the hillshade both maps draw | `client/js/hudmap.js` |
| the panels themselves | `client/js/{land,build,pool,permission,wallet,…}ui.js` |
| the Work window's look (v8) | `client/work.css` |
| what this machine is doing, and the loop behind it | `client/js/workui.js` |
| Work's Settings tab | `client/js/worksettings.js` |
| the four queues, one per kind of work | `client/js/renderpool.js` |
| one job as a card, and the chips over the cards | `client/js/poolcard.js` |
| a card opened | `client/js/jobdetail.js` |

Three places where the Work window differs from v8. What this machine is doing
is the strip along the top of the page rather than a strip inside the panel: it
is true wherever you are looking, so it is a chip beside the bell (`#machine`
in `client/top.css`), and the panel is nothing but its queues. The preview went
with it — a picture of a tile belongs on that tile's card. And, because the
build has no such thing to show: its Publish tab holds finished work waiting on the machine
for a person to review and then upload, and nothing is held back here — a
piece's bytes are uploaded and registered as it is computed, and the tile
publishes when its last one lands (Invariant 3) — so that tab is the pool's own
`publish` phase, the packing and the merge (db/0152). And there is no storage
cap to report, so Settings is the two switches, what this machine is, how far
each zoom has got and the log.

`../SPEC.md` is the product specification the design serves. Where the two
differ the design is newer — it says so in its own first line ("turn 3 ·
refined against the build"). Two places where this build deliberately differs
from both, because it went further: a rendered tile is a **candidate** that a
person approves (the spec has approval before rendering), and land is drawn in
QGIS rather than assigned by an admin.
