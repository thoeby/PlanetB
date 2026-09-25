# TASKS-ui.md — the chrome, the marketplace, placing, Automate, Work

The owner's list of 2026-09-25 (after TASKS-live.md), with the plan that
implements it. Read `CLAUDE.md` first; every invariant holds. The three
screenshots the owner attached (Marketplace › Selling, Shop, Earnings) are the
inspiration for the Marketplace; nothing else in `docs/design/` changes.

One task = one commit `UI.x: title`, `make gate` green, the story named in the
task green, and every story that already reached the surface it changes kept
green (their helpers change with it).

## Decisions the list states

* **The money system is not built here.** It is being replaced by GNU Taler.
  The Marketplace is wired to what exists — products, orders, rights, the
  ledger, placed things — and whatever needs new money code (the Market of
  used licences, bids, changing a price, taking a product off sale) is drawn,
  greyed out, and says why.
* **Trade & Sell is the Marketplace.** Products are bought, sold and
  registered there. Build's catalog becomes **Inventory**: what you can place
  — your own products, what you hold a licence for, and what you took for free
  — and nothing else.
* **The top bar is the only bar at the top.** No wordmark. The views are glyphs
  on the bar when the bar has room for them and the drawer (Tab) when it has
  not — one or the other, never both. The compass and the line under it (land,
  owner, right, where) move into the bar. A workspace view (Work, Marketplace,
  Automate) puts its tabs into the bar where the compass is, and loses its
  title — the glyph already says which view it is.
* **Undo and redo are icons on the bar** (a label on hover), for whatever is
  being edited: the ground in Terrain, the flow in Automate's editor.
* **Automate has four tabs**: Flows (the start page: your flows, where each
  runs), Editor (the block canvas), Schedule (the Planner, full size), Paths
  (a minimal route drawer for movers). The left column's *My flows / On
  <server>* tabs go: the Server control decides what the column lists, and
  **My collection** is its first entry, set apart from the servers.
* **Build is quieter**: no "Next on …" card, no legend card, the altimeter
  lives in the map, and the key hints fold away to one line.
* **Placing frames the thing**: Place on an Inventory card moves the camera
  to a distance that fits the product's size, with the spot it lands on in
  the middle of the view, and says how to put it down. A product picked from
  the Place panel's own list gets the sentence but leaves the camera alone:
  the stories from 40 on put things down from where they stand, and a camera
  that moved under them would put the gate somewhere else.

## Decisions made while planning

* **Element ids the stories read are kept** where the thing they name still
  exists (`#land`, `#standing .coords`, `#q`, `#results`, `#detail`,
  `button.buy`, `#upload-type`, `#file`, `#name`, `#publish`, `#form-parts`,
  `#upload-status`, `#flows`, `.fl-*`). What moves is where they are.
* **Surface and part names**: the Marketplace surface holds the parts
  `Shop`, `Market`, `Selling`, `Register`, `Licences`, `Earnings`; Build's `Catalog` leaf
  is now `Inventory`; Automate's parts are `Flows`, `Editor`, `Schedule`,
  `Paths`. `panel()` in the stories reaches all of them by name, as before.
* **The bar decides "room" by measuring**, not by a breakpoint: the views'
  glyphs are laid out, and if the bar overflows they fold into the drawer.
* **Placed counts, sales and earnings are read, never stored**: instances by
  product, orders for your products (the maker may read them, db/0206), the
  ledger rows into your account.

## The tasks

### UI.1 One bar — story 49
* `topbar.js`: no wordmark; views inline or in the drawer (measured); a
  centre slot that holds the compass and the place line in Build and Play and
  the view's tabs in Work, Marketplace and Automate; an edit slot for undo /
  redo icons with hover labels.
* `hud.js`: a workspace's panel has no header; its tabs render into the bar.
* Stories: `players.js` `panel()` finds a part wherever the tabs are drawn;
  `panelApp()` presses the view's glyph when it is on the bar, the drawer
  when it is not.
* **Story 49**: at 1280 px the views are glyphs and the drawer button is
  gone; narrowed, they fold into the drawer and the button is back. The land
  line is in the bar. Work's tabs are in the bar and the panel has no title.

### UI.2 Build is quieter — story 49 (continued)
* No `nextstep.js` card; no legend; the altimeter drawn inside the map box;
  the key hints fold to one line (remembered per browser).

### UI.3 Inventory and placing — story 50
* Build › Inventory: your products, your licences, what you took for free, as
  cards with **Place**. Place picks it in the Place panel, enters build mode
  and frames the camera to the product's size, with a line saying how to put
  it down and how to cancel.
* **Story 50**: B opens Inventory, presses Place on the crate; the camera
  comes close enough that the crate fills a sensible part of the view; one
  click puts it down.

### UI.4 Marketplace: Shop — story 51
* Trade & Sell is Marketplace. Shop: category and maker filters with counts,
  search, sort (newest, cheapest, most placed), product cards (price, placed
  count, Buy / Yours / Held), a detail column (what it is, placed count, how
  many you hold, the price, how many, pay from, Buy new). Market is a greyed
  tab and a greyed "market offer" line.

### UI.5 Marketplace: Selling and putting a model on sale — story 51
* Your products; the selected one's numbers (sold, earned, placed; resold
  greyed), its price (greyed editing: changing a price comes with the new
  payment system), 14 days of sales, and the orders (who, how many, state,
  amount).
* **Register** is a Marketplace tab of its own (the owner's follow-up: the
  whole of registering is in the Marketplace, nothing of it in Build): the
  model large on the left, four steps on the right — the model and its size,
  its parts and what sets it off, name and price, register — replacing the
  catalog's one long form. Selling's "Register a model" opens it.

### UI.6 Marketplace: Licences and Earnings — story 51
* Licences: what you hold, since when, which version it follows, how many
  you have placed. Earnings: this month, new copies, resales (greyed), on its
  way (pending orders), 30 days, and what came in.
* **Story 51**: C puts a model on sale through the steps; B finds it in the
  Shop, buys two, sees them under Licences and in Inventory; C sees the sale
  under Selling and the credit under Earnings.

### UI.7 Work tabs and Hosting — story 52
* Work's tabs are in the bar (UI.1). Hosting explains itself: what hosting
  is, the three steps, your land's files, what your tab hosts now and what it
  has served; offers are cards with land, files, size, term and bounty.
* **Story 52**: B reads what hosting is and offers his field from the card;
  C hosts it from the offer card and sees the files her tab holds.

### UI.8 Automate's four tabs — story 53
* Flows (start page), Editor, Schedule (the Planner), Paths (routes for
  movers, drawn on the land's map). The Server control lists My collection
  first; the left column follows it. The Automate bar: where and what on the
  left, Server and Auto-layout and the actions on the right; undo / redo on
  the top bar.
* **Story 53**: B opens Automate on the Flows tab, opens a flow into the
  Editor, undoes a change from the top bar, switches the Server control to
  alpha and back to My collection, opens Schedule, and draws a route in
  Paths.

### UI.9 Terrain's undo and redo on the bar — story 53 (continued)
* The Shape panel's undo / redo are the bar's icons while Terrain is open.
