# The world in a headset

`play.html?xr=1` lowers the streaming budget and offers an **enter VR** button.
Everything else about the page is the same page.

## What the flag changes

| | desktop | `?xr=1` |
|---|---|---|
| splats held | 25 M | 8 M |
| tiles held | 40 | 24 |
| tiles in flight | 4 | 2 |

`client/js/xr.js` owns those numbers and `client/js/tiles.js` enforces them: the
streamer already drops the tiles that do not fit, so nothing else had to know.
The budget is lowered by the flag rather than by the session, because the tiles
have to be loaded before there is anything to enter.

A headset draws the world twice at 90 Hz on a mobile GPU. 8 M splats is what
TASKS.md WP5.4 asks for and roughly what a Quest 3 will hold at that rate; a
tethered headset on a desktop GPU can take the desktop budget, and the way to
give it one is `?xr=1` with the limits raised in `xr.js`, not a second page.

## Locomotion

Teleport, and only teleport: smooth motion in a headset is what makes people
sick. A trigger pull casts the controller's ray at the terrain
(`teleportTarget`, the same `raycastGround` build mode uses), and the rig moves
so the eyes land 1.7 m above the ground it hit. A ray at the sky, past 120 m, or
at ground this tab has not streamed moves nobody and says "no ground there".

The camera is reparented to a rig **when a session starts** and not before, so
outside XR the page is exactly the page every other browser test flies.

## What has not been run

**There is no headset here, and no XR runtime in headless chromium.** What the
gate checks is that `?xr=1` takes the smaller budget, that the panel appears,
and that a browser without a runtime says so and keeps rendering
(`client/test/e2e/xr.spec.js`, `client/test/xr.test.js`).

The manual check, on a device:

1. Serve `client/` over **https** — WebXR refuses an insecure origin. Any TLS
   terminator in front of the static files will do; the API and the file store
   can stay where they are, `edit.html` and `play.html` read their endpoints
   from the `<meta>` tags.
2. Open `play.html?xr=1` in the headset's browser, sign in, press **enter VR**.
3. Check, and write down what you saw:
   - the world is there at all, and the ground is under you rather than through
     you (the rig puts the eyes 1.7 m up; a floor-level `local-floor` space
     already accounts for the wearer's height, so if you are 3.4 m tall this is
     why);
   - both eyes draw the same tiles — a splat sorted per eye is the first thing
     that goes wrong;
   - the frame rate with `.work-world` on and off. Background rendering paces
     itself off the frame time, and a headset's frame time is the one that
     matters;
   - a teleport lands where the ray pointed, and a teleport at the sky does
     nothing;
   - leaving the session gives the camera back to the player without a jump.

Until that has been done on hardware, WP5.4's acceptance is unticked, and
PROGRESS.md says so.
