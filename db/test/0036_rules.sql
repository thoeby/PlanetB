-- What a feature becomes is a rule, and changing a rule changes the world
-- (db/0036_rules.sql, db/0037_ruleseed.sql).
BEGIN;
SELECT plan(8);

SET client_min_messages = warning;

SELECT ok((SELECT count(*) FROM build_rule WHERE kind = 'forest') >= 10,
          'the species that were a constant in props.js are rows');
SELECT ok((SELECT count(*) FROM build_rule
           WHERE kind = 'forest' AND filter = '[]'::jsonb) = 1,
          'and exactly one of them is the else-rule');

-- Ordering is the whole semantics: first match wins, catch-alls last.
SELECT is((SELECT name FROM build_rule WHERE kind = 'forest'
           ORDER BY ordering, id LIMIT 1), 'spruce',
          'a named species is tried before the catch-all');

-- The rule set is part of what a tile was built from (Invariant 2).
CREATE TEMP TABLE before AS SELECT rules_digest() AS d,
    world_snapshot(14, 8500, 5700) AS snap;
UPDATE build_rule SET style = style || '{"taper": 0.99}'::jsonb WHERE name = 'spruce';
SELECT isnt(rules_digest(), (SELECT d FROM before),
            'editing a rule moves the rule digest');
SELECT isnt(world_snapshot(14, 8500, 5700), (SELECT snap FROM before),
            'and every tile snapshot with it, so open atoms know they are stale');

-- Invariant 4: the trigger marks dirty, it does not build anything.
INSERT INTO tile (z, x, y, dirty, expected_version)
VALUES (14, 4242, 4242, false, 3) ON CONFLICT (z, x, y) DO UPDATE SET dirty = false;
UPDATE build_rule SET ordering = ordering WHERE name = 'oak';
SELECT is((SELECT dirty FROM tile WHERE z = 14 AND x = 4242 AND y = 4242), true,
          'a rule change marks the tiles dirty');
SELECT is((SELECT expected_version::int FROM tile WHERE z = 14 AND x = 4242 AND y = 4242), 4,
          'and bumps the version, so a worker mid-flight cannot publish over it');

-- The compiler is handed the rules with the world it has to build.
SELECT is((SELECT jsonb_array_length(tile_world(14, 8500, 5700) -> 'rules')),
          (SELECT count(*)::int FROM build_rule WHERE enabled),
          'tile_world carries every enabled rule');

SELECT * FROM finish();
ROLLBACK;
