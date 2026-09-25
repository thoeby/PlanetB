// schedule.js: a cron trigger as a preset, a sentence and a week.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cronOf, scheduleOf, scheduleWords, scheduleLine, weekOf, DAYS }
    from '../flow/server/schedule.js';

test('every N minutes between two times, on some days', () => {
    const s = { preset: 'minutes', every: 5, from: '17:00', to: '22:55', days: DAYS };
    assert.equal(cronOf(s), '*/5 17-22 * * *');
    assert.deepEqual(scheduleOf('*/5 17-22 * * *'), s);
    assert.equal(scheduleWords(s), 'Every 5 minutes from 17:00 to 22:55, every day.');
    assert.equal(cronOf({ ...s, days: ['Mo', 'Tu', 'We', 'Th', 'Fr'] }), '*/5 17-22 * * 1,2,3,4,5');
    assert.equal(cronOf({ preset: 'minutes', every: 15, from: '00:00', to: '23:59' }),
        '*/15 * * * *');
});

test('every hour, every day at, weekdays at', () => {
    assert.equal(cronOf({ preset: 'hourly', at: '00:30' }), '30 * * * *');
    assert.deepEqual(scheduleOf('30 * * * *'), { preset: 'hourly', at: '00:30', days: DAYS });
    assert.equal(cronOf({ preset: 'daily', at: '03:00' }), '0 3 * * *');
    assert.equal(scheduleWords(scheduleOf('0 3 * * *')), 'Every day at 03:00.');
    assert.equal(cronOf({ preset: 'weekdays', at: '06:00' }), '0 6 * * 1-5');
    assert.deepEqual(scheduleOf('0 6 * * 1-5'),
        { preset: 'weekdays', at: '06:00', days: ['Mo', 'Tu', 'We', 'Th', 'Fr'] });
    assert.equal(scheduleWords(scheduleOf('0 6 * * 1-5')), 'Weekdays at 06:00.');
});

test('anything else is custom, and never throws', () => {
    assert.deepEqual(scheduleOf('0 6,12,18 * * *'),
        { preset: 'custom', expression: '0 6,12,18 * * *' });
    assert.equal(scheduleOf('every evening').preset, 'custom');
    assert.equal(cronOf({ preset: 'custom', expression: '0 0 29 2 *' }), '0 0 29 2 *');
    assert.equal(scheduleWords({ preset: 'custom', expression: '0 0 29 2 *' }), 'cron 0 0 29 2 *');
});

test('the week says how often a day, and the line says what is next', () => {
    const thu = new Date(2026, 8, 24, 18, 2);
    const week = weekOf('*/5 17-22 * * *', thu);
    assert.equal(week.length, 7);
    assert.deepEqual(week.map((d) => d.minutes.length), [72, 72, 72, 72, 72, 72, 72]);
    assert.equal(week[0].minutes[0], 17 * 60);
    assert.equal(scheduleLine('*/5 17-22 * * *', thu),
        '72 runs a day · next at 18:05 · A cron trigger checks at most once a minute.');
    assert.equal(scheduleLine('0 3 * * *', thu),
        '1 run a day · next at Fr 03:00 · A cron trigger checks at most once a minute.');
    assert.deepEqual(weekOf('0 6 * * 1-5', thu).map((d) => d.minutes.length),
        [1, 1, 0, 0, 1, 1, 1]);
    assert.throws(() => weekOf('nonsense', thu));
});
