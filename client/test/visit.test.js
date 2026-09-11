// A link is a place (TASKS-usable T8): what the address bar carries, and what
// comes back out of it.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseVisit, visitHash, visitLink } from '../js/visit.js';

test('a link carries where you are standing and which way you face', () => {
    const here = { lat: 47.38012, lon: 8.55004, h: 412.4, heading: 135.2 };
    const link = visitLink('http://host/app/play.html?x=1#at=0,0,0,0', here);
    assert.equal(link, 'http://host/app/play.html?x=1#at=47.38012,8.55004,412,135');
    const back = parseVisit(link);
    assert.equal(back.lat, 47.38012);
    assert.equal(back.lon, 8.55004);
    assert.equal(back.h, 412);
    assert.equal(back.heading, 135);
});

test('a page opened with no place in it is not sent anywhere', () => {
    assert.equal(parseVisit('http://host/app/play.html'), null);
    assert.equal(parseVisit('http://host/app/play.html#tab=Setup'), null);
    assert.equal(parseVisit('http://host/app/play.html#at='), null);
});

test('nonsense in the address bar is not a place', () => {
    assert.equal(parseVisit('#at=over,there,now,0'), null);
    assert.equal(parseVisit('#at=91,0,0,0'), null, 'no such latitude');
    assert.equal(parseVisit('#at=0,181,0,0'), null, 'no such longitude');
});

test('the height and the heading are optional', () => {
    assert.deepEqual(parseVisit('#at=47.5,8.5'),
        { lat: 47.5, lon: 8.5, h: 0, heading: 0 });
});

test('the hash is what a viewer would type', () => {
    assert.equal(visitHash({ lat: -0.5, lon: 179.99999, h: 0, heading: 359.6 }),
        '#at=-0.50000,179.99999,0,360');
});
