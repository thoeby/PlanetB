// playeditors.js — the editors (TASKS-editors.md): the Blueprint clay and the
// mode around it, Shape and Lines on it, and Survey's Areas and Requests
// (play.js).

import { Blueprint } from './blueprint.js';
import { mountBlueprintMode } from './bpmode.js';
import { mountShape } from './shapeui.js';
import { mountLines } from './linesui.js';
import { mountSurveyAreas } from './surveyareas.js';
import { mountRequests } from './requestsui.js';
import { mountShapeSettings } from './shapesettings.js';

export function mountEditors(ctx) {
    const { app, pc, hud, doc } = ctx;
    // EDT.1: the ground as white clay, for Shape and Lines (client/js/blueprint.js).
    ctx.blueprint = new Blueprint(app, pc, { origin: ctx.origin, floor: ctx.floor,
        streamer: ctx.streamer, groundMesh: ctx.groundMesh, preview: ctx.preview });
    // EDT.1–5: the mode around it — its camera, the words at the pointer, Tab's
    // peek and the section strip — which Shape and Lines open (client/js/bpmode.js).
    ctx.bpmode = mountBlueprintMode({ bp: ctx.blueprint, app, pc, camera: ctx.camera,
        canvas: ctx.canvas, player: ctx.player, setDriving: (v) => ctx.setDriving?.(v),
        host: doc.getElementById('hud'),
        // How much of the view the open panel and the corner card cover.
        inset: () => ({
            left: doc.querySelector('#panel[data-open="1"]')?.getBoundingClientRect().right ?? 0,
            right: Math.max(0, window.innerWidth - (doc.querySelector('#bp-side:not([hidden])')
                ?.getBoundingClientRect().left ?? window.innerWidth)),
        }) });
    const lands = () => ctx.api.rpc('my_areas').catch(() => []);
    const onSaved = () => { ctx.build.refresh(); ctx.submit.refresh(); };
    // EDT.6: the ground itself, shaped on the clay. Opening Shape is shaping
    // (client/js/shapeui.js); opening anything else, or closing it, closes the
    // clay and hands the camera back.
    ctx.sculpt = mountShape(hud.panel('Shape'), {
        bpmode: ctx.bpmode, bp: ctx.blueprint, app, pc, onSaved,
        // Stay, when leaving with strokes unsaved.
        reopen: () => hud.show('Shape'),
    }, { lands });
    hud.whenShown('Shape', () => ctx.sculpt.enter());
    groundEdits(ctx);
    // EDT.13: the lines on a land, drawn on the same clay (client/js/linesui.js).
    ctx.lines = mountLines(hud.panel('Lines'), {
        bpmode: ctx.bpmode, bp: ctx.blueprint, app, pc, onSaved,
        reopen: () => hud.show('Lines'),
        // EDT.17: the one place a line and the ground meet (PLAN-editors D3).
        layBed: async (bed) => { hud.show('Shape'); await ctx.sculpt.bed(bed); },
    }, { lands });
    hud.whenShown('Lines', () => ctx.lines.enter());
    hud.whenOpened((name) => { if (name !== 'Lines') ctx.lines.leave(); });
    hud.whenOpened((name) => { if (name !== 'Shape') ctx.sculpt.leave(); });
    // The operator's say over shaping: how far the ground may move, and the
    // fade at a land's edge (Settings · Setup, admins).
    mountShapeSettings(hud.panel('Setup'));
    // EDT.19: areas drawn on the map, and who is waiting for land, as parts of
    // Survey of their own (client/js/surveyareas.js, client/js/requestsui.js).
    ctx.surveyAreas = mountSurveyAreas(hud.panel('Areas'));
    hud.whenShown('Areas', () => ctx.surveyAreas.open());
    ctx.requests = mountRequests(hud.panel('Requests'), {
        draw: (id) => { hud.show('Land'); ctx.assignLand?.choose?.(id); },
    });
    hud.whenShown('Requests', () => ctx.requests.refresh());
}

// UI.9: while Shape is open, the bar's undo and redo are the ground's — the
// same two the rail beside the tools has. A stroke is one once it is let go
// of, on the canvas, so the bar asks again wherever a pointer comes up.
function groundEdits(ctx) {
    const { hud } = ctx;
    const shaping = () => ctx.sculpt.shaping();
    hud.edits.use('ground', {
        live: () => hud.opened() === 'Shape' && Boolean(shaping()),
        undo: () => document.querySelector('.sc-undo')?.click(),
        redo: () => document.querySelector('.sc-redo')?.click(),
        canUndo: () => Boolean(shaping()?.strokes.length),
        canRedo: () => Boolean(shaping()?.undone.length),
    });
    window.addEventListener('pointerup', () => hud.edits.changed());
    window.addEventListener('keyup', () => hud.edits.changed());
}
