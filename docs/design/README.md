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
| which surface a view opens, and which view a surface belongs to | `client/js/apps.js` (`surface`), `client/js/tabbar.js` (`view`) |
| the strip's cells: apps, numbers, clock, wallet, bell, you | `client/js/topbar.js` |
| a notification's eight seconds, and the tray after them | `client/js/notify.js` |
| the house styles a panel's contents inherit | `client/panel.css` |
| every surface there is, its key, its icon and where it opens from | `client/js/tabbar.js` |
| the bar and the altimeter's look | `client/bar.css` |
| the altimeter's arithmetic | `client/js/altimeter.js` |
| the frame, the panel and its tabs, the app the chrome is dressed for | `client/js/hud.js` |
| the map in the corner, and the hillshade both maps draw | `client/js/hudmap.js` |
| the panels themselves | `client/js/{land,build,pool,permission,wallet,…}ui.js` |
| Symbols: the four columns, and what each holds | `client/symbols.css`, `client/js/symbol{sui,html,list,form,layers,try,preview}.js` |
| Vocabulary: the kinds, and what one may say about itself | `client/js/{adminui,vocabui}.js` |
| Ground cover: the four steps | `client/js/{coverui,coverform,covertile,coversld}.js` |
| Survey's map, and the nodes around it | `client/js/{landmap,assignland,assignform}.js` |
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

## Five of the six views open something (F1–F6)

chrome6 drew six views and the build wired one, so five of the cards said "not
wired yet" and pressing one changed a hue. A view names the surface it opens
(`client/js/apps.js` `surface`) and a surface names the view it belongs to
(`client/js/tabbar.js` `view`), and switching opens it:

| view | plinth | opens |
|---|---|---|
| Build · F1 | Place · Catalog · Land · Publish · Terrain | the world |
| Automate · F2 | — | the flow editor, which takes the window itself |
| Work · F3 | — | the Work surface: four queues and the machine |
| Trade & Sell · F4 | — | the catalog, full window |
| Play · F5 | Build's | nothing yet — walking is built, visiting is not |
| Survey · F6 | — | the land map: who is waiting, and the ground it is drawn on |

Two things follow. **Work takes the window** rather than the 1 040 px drawer it
had: four queues of cards beside a card opened is the window the design draws
(v8), and it is `wide` in `tabbar.js` like Settings' own wide parts. **Survey is
where the land map lives**, not a tab of Settings — nobody looking for a map
opens Settings — and it has no button on either bar, because a map of the whole
world is a workspace rather than a drawer over the one you are standing in.

**The plinth belongs to the view it is in** (`tabbar.js` `barOf`). Every bar
surface names its view, and the chrome shows that view's and hides the rest. A
view marked `full` (`apps.js`) is a workspace and takes the window: no plinth,
no altimeter, no controls panel, no map in the corner, no legend, no crosshair,
and its panel reaches the bottom edge. Four of the six are — Automate, Work,
Trade & Sell, Survey — and Build and Play are the world itself, so they keep
all of it. The compass and the place line stay everywhere, because where you
are is true in every view.

**Terrain is Build's fifth button**, holding FND.9's shaping tools. It was a
second tab of Land, which is a panel about who owns what; shaping the ground is
something you do standing in it with a brush in hand. **Work left Build's
plinth**: a window of everybody's queues under a strip about the land you are
standing on was two views at once.

A view may open a surface that belongs to another — Trade & Sell opens the
catalog, which is on Build's plinth — and doing so does not walk you back into
that view. The surface is as wide as the view needs it: a 666 px drawer in
Build, the window in Trade & Sell.

## Symbols, redrawn

The operator's reference for this part is a turn of the design that is not in
the artboards here: four columns under one strip, and everything a symbol is
said where it is edited.

| what | where |
|---|---|
| the strip: what is saved against what the world is built with, and Apply | `symbolhtml.js` `HTML`, `symbols.css` |
| the symbols, grouped by kind, each with its layer count and a switch | `symbollist.js` |
| the name, the kind and order behind it, and the conditions | `symbolhtml.js`, `symbolform.js` |
| the stack in order, beside the layer in hand and its fields | `symbollayers.js` |
| the sample, the values it is tried with, and every version | `symbolpreview.js`, `symboltry.js` |

Five things the build did not have, each of them a question the panel could
not answer before:

- **How many features does this catch?** `feature_matches` (db/0175) is
  `client/lib/rules.js`'s matcher in SQL, over the conditions as they now
  stand — not as they were last saved. A symbol that matches nothing and one
  that matches every road in the valley looked identical while being edited.
- **Which version is the world built with?** Said beside the name, and on
  every line of the history, which is now simply on screen rather than behind
  a button.
- **What does this layer do?** Each line of the stack says what it is set to
  (`layerSays`), so a stack of four reads as four things rather than as
  "Surface, Repeat, Repeat, Check".
- **Which field is wrong?** A product of the wrong kind is said on the field
  it was typed into (`fieldTrouble`), not only in the sentence at the foot.
- **What am I trying it with?** The sample offers a row for every property the
  symbol mentions, with the widget its own value implies: a switch for `yes`,
  a stepper for a number, a field for a word.

And the order — which is the whole of how symbols resolve — is dragged, within
a kind, rather than typed as a number into a form.

## Settings' three wide parts

Symbols, Vocabulary and Ground cover each take the whole window, and each is
now the same shape: a list of what there is on the left, and what one of them
is on the right. A wide panel also puts the corner instruments away while it
is open (`#hud[data-covered]`), because the altimeter and the map sit over it.

**Vocabulary** was a `<select>` of thirty kinds and two browser `prompt()`s for
a new one. The kinds are a list grouped by what they are about — drawn on the
ground, products, land — each saying what it is drawn as, how much it may say
about itself, and how many of them are in the world. A kind's own label, shape
and order are editable, and so is every field of every property: `put_kind` and
`put_property` have taken a label and an ordering since db/0040 and the panel
could set neither, so a typo in a label meant dropping the property and writing
it again.

**Ground cover** was a wall of controls with nothing saying which came first —
an address, a user, a password, a connect, a layer, a priority, an add, a read,
an attribute, a style download, a table of six unlabelled inputs and a save. It
is four numbered steps: add a source (behind its own button, because it is done
once), read what is in it, say what each class is, keep it. The class table has
headings and shows how much of the ground each class is, which was counted and
never drawn.

**`splatworld-v10.dc.html` is the design of record for F10** — process
servers, and flows on things (`TASKS-flows.md`) — on `chrome8.dc.html`. It
was drawn from `flows-servers.md`, which lists every screen, control, state
and sentence the stories need: 10a–10c are the three whole screens (Automate
drawing a flow with the server picker, Automate on a server with a run in the
bottom panel, and a lamp's card with its flows and Run on…), 10d–10k the
dialogs and the other states, and 10l every sentence with the colour it
takes. `splatworld-v9.dc.html` is the turn before it, the whole page in one
file. Where the build and 10l differ in a word, 10l wins.

Built from v10 so far: every sentence of 10l that a story reaches, in its
colour (`[data-tone]` in `client/hud.css`); the server picker's dot and words;
Remove asked or refused (10f); a process from a server marked Read-only with
Save into my land… in the bar (10b); the run panel named with its time; the
lamp card's Flows section with the chip, Run on… with its cron preview, and
Stop asked first (10c, 10k). Not built: 10a's layout — the palette as a
column of its own and the status line under the canvas are v9's Automate,
which the build has not taken yet — the dots inside the server dropdown
(10d; a native select cannot draw them), and the inspector's "On alpha"
card.

**The Planner** (`TASKS-flows.md` FL.8) is drawn from the operator's sketch,
`assets/planner-sketch.png`: lanes a job over a day, the runs on them, next
runs on the right, one job's run times underneath. Built in
`client/js/planner*.js` and `client/planner.css`. Its **Edit job** sketch
draws a cron trigger as a schedule — Every … minutes between two times on
chosen days, Every hour, Every day at, Weekdays at, or Custom — with the
sentence it means, the expression beside Edit as text, runs a day and the next
run, and the next seven days as ticks with Open in planner. Built in
`client/js/scheduleui.js` over `client/flow/server/schedule.js` (the presets
read into and out of the five fields); the four Add trigger buttons are the
sketch's tabs, on a schedule · on a request · on a file · on a message.
