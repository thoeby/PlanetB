// stages.js — the five stages of the route through the app, in order, as the
// chrome shows them. Its own module because both client/js/hud.js (which
// re-exports it for the panels) and client/js/chrome.js (which draws it) need
// it, and neither may import the other.
//
// Credits are not a stage: they sit in their own chip beside these.
export const STAGES = [
    { key: 'placed', label: 'Placed' },
    { key: 'pool', label: 'In pool' },
    { key: 'rendered', label: 'Rendered', tone: 'accent' },
    { key: 'awaiting', label: 'Awaiting', tone: 'warn' },
    { key: 'published', label: 'Published', tone: 'accent' },
];
