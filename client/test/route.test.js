// FND.16 — where a thing that moves by the clock is.
//
// The rule the story rests on: the same second gives the same place, whoever
// asks. Everything else is what a timetable means — a stop holds, a route that
// comes back comes back facing the other way.

import test from 'node:test';
import assert from 'node:assert/strict';

import { alongOf, atMetres, lengthOf, metresBetween, positionAt, runSeconds }
    from '../lib/route.js';

// A kilometre of straight road, due east from a point near Visp.
const KM = 1000 / (111320 * Math.cos(46.29 * Math.PI / 180));
const ROAD = [[7.86, 46.29], [7.86 + KM, 46.29]];
const EVERY = { every_s: 600, loop: 'circle' };

const near = (a, b, tol) => assert.ok(Math.abs(a - b) < tol,
    `${a} is not within ${tol} of ${b}`);

test('a kilometre of road is a kilometre long', () => {
    near(metresBetween(...ROAD), 1000, 1);
    near(lengthOf(ROAD), 1000, 1);
    assert.deepEqual(alongOf(ROAD).length, 2);
});

test('a point so many metres along is where it should be', () => {
    const half = atMetres(ROAD, alongOf(ROAD), 500);
    near(half.lon, 7.86 + KM / 2, 1e-6);
    near(half.heading, 90, 0.5);
    // Past either end is the end: a bus does not drive off the road.
    assert.deepEqual(atMetres(ROAD, alongOf(ROAD), -50).lon, 7.86);
    near(atMetres(ROAD, alongOf(ROAD), 5000).lon, 7.86 + KM, 1e-9);
});

test('a run is the driving plus every stop it makes', () => {
    const plain = runSeconds(ROAD, EVERY, 36);
    near(plain.run, 100, 0.2);
    const stopping = runSeconds(ROAD,
        { ...EVERY, dwell: [{ at_m: 500, s: 30 }] }, 36);
    near(stopping.run, 130, 0.2);
});

test('the same second is the same place, however often it is asked', () => {
    const a = positionAt(ROAD, EVERY, 36, 12345);
    const b = positionAt(ROAD, EVERY, 36, 12345);
    assert.deepEqual(a, b);
});

test('a bus at ten metres a second is where ten metres a second puts it', () => {
    near(positionAt(ROAD, EVERY, 36, 0).along, 0, 0.01);
    near(positionAt(ROAD, EVERY, 36, 25).along, 250, 1);
    near(positionAt(ROAD, EVERY, 36, 50).along, 500, 1);
    // A hundred seconds is the whole kilometre; the rest of the ten minutes it
    // waits for the next one.
    near(positionAt(ROAD, EVERY, 36, 100).along, 1000, 1);
    near(positionAt(ROAD, EVERY, 36, 400).along, 1000, 1);
    near(positionAt(ROAD, EVERY, 36, 600).along, 0, 0.01);
});

test('a stop holds, and everything after it is that much later', () => {
    const stops = { ...EVERY, dwell: [{ at_m: 500, s: 30 }] };
    near(positionAt(ROAD, stops, 36, 50).along, 500, 1);
    near(positionAt(ROAD, stops, 36, 70).along, 500, 1);   // still standing
    near(positionAt(ROAD, stops, 36, 80).along, 500, 1);   // just leaving
    near(positionAt(ROAD, stops, 36, 90).along, 600, 2);
});

test('back and forth comes back, facing the other way', () => {
    const back = { every_s: 600, loop: 'back_and_forth' };
    near(positionAt(ROAD, back, 36, 50).along, 500, 1);
    near(positionAt(ROAD, back, 36, 50).heading, 90, 0.5);
    near(positionAt(ROAD, back, 36, 150).along, 500, 1);
    near(positionAt(ROAD, back, 36, 150).heading, 270, 0.5);
    near(positionAt(ROAD, back, 36, 200).along, 0, 1);
});

test('the phase moves the whole timetable, and nothing else', () => {
    near(positionAt(ROAD, EVERY, 36, 0, 25).along,
        positionAt(ROAD, EVERY, 36, 25).along, 0.01);
});

test('a route with nowhere to go has no position at all', () => {
    assert.equal(positionAt([], EVERY, 36, 10), null);
    assert.equal(positionAt([[7.86, 46.29]], EVERY, 36, 10), null);
});
