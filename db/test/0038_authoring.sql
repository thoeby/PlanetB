-- A player makes their own ground and retries a failed render
-- (db/0038_authoring.sql). Before this, both needed psql.
BEGIN;
SELECT plan(18);

SET client_min_messages = warning;

INSERT INTO auth.user (id, email, pw_hash, role) VALUES
('00000000-0000-0000-0000-0000000a8001', 'mk-owner@example.com', 'x', 'player'),
('00000000-0000-0000-0000-0000000a8002', 'mk-stranger@example.com', 'x', 'player');
INSERT INTO account (owner_id) VALUES
('00000000-0000-0000-0000-0000000a8001'), ('00000000-0000-0000-0000-0000000a8002');

SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000a8001","role":"player"}';
SET LOCAL role = 'player';

-- ------------------------------------------------------------------- areas

SELECT throws_ok(
    $$INSERT INTO area (geom, owner_id, detail)
      VALUES (st_makeenvelope(20.0, 20.0, 20.1, 20.1, 4326),
              '00000000-0000-0000-0000-0000000a8001', 14)$$,
    '42501', NULL,
    'a player still may not write the area table directly (Invariant 6)');

CREATE TEMP TABLE mine AS SELECT create_area(
    '{"type":"Polygon","coordinates":[[[20,20],[20.1,20],[20.1,20.1],[20,20.1],[20,20]]]}'::jsonb,
    14, 'My valley') AS id;

SELECT is((SELECT count(*) FROM area a JOIN mine ON mine.id = a.id), 1::bigint,
          'create_area makes the area');
SELECT is((SELECT a.owner_id FROM area a JOIN mine ON mine.id = a.id),
          '00000000-0000-0000-0000-0000000a8001'::uuid,
          'the caller owns it, whatever they pass');
SELECT is((SELECT a.rules ->> 'name' FROM area a JOIN mine ON mine.id = a.id),
          'My valley', 'the name rides in rules, which area_view already shows');
SELECT is((SELECT a.rules ->> 'required_approvals' FROM area a JOIN mine ON mine.id = a.id),
          '1', 'and the approval rule keeps its default');
SELECT is((SELECT count(*) FROM jsonb_array_elements(my_areas())), 1::bigint,
          'my_areas lists it');

SELECT throws_ok(
    $$SELECT create_area('{"type":"LineString","coordinates":[[20,20],[21,21]]}'::jsonb)$$,
    NULL, NULL, 'an area is one polygon');
SELECT throws_ok($$SELECT create_area('{"type":"Nonsense"}'::jsonb)$$,
    NULL, NULL, 'nonsense GeoJSON is refused, not stored');

-- 0032_zerodetail: a blank number means the baseline.
CREATE TEMP TABLE blank AS SELECT create_area(
    '{"type":"Polygon","coordinates":[[[40,40],[40.1,40],[40.1,40.1],[40,40.1],[40,40]]]}'::jsonb
    ) AS id;
SELECT is((SELECT a.detail FROM area a JOIN blank ON blank.id = a.id), 14::smallint,
          'detail 0 becomes the baseline, as it does for a drawn area');

-- --------------------------------------------------------------- detail

SELECT cmp_ok((SELECT set_area_detail((SELECT id FROM mine), 16)), '>', 0,
    'compiling deeper dirties the tiles that have to be built');
SELECT cmp_ok((SELECT count(*) FROM tile WHERE z = 16), '>', 0::bigint,
    'and the z16 tiles now exist to be compiled');
SELECT is((SELECT set_area_detail((SELECT id FROM mine), 12)), 0,
    'asking for less dirties nothing');

SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000a8002","role":"player"}';
SELECT throws_ok($$SELECT set_area_detail((SELECT id FROM mine), 18)$$,
    '42501', NULL, 'a stranger may not change my area''s detail');
SELECT throws_ok($$SELECT delete_area((SELECT id FROM mine))$$,
    '42501', NULL, 'nor delete it');

SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000a8001","role":"player"}';

-- ------------------------------------------------------------------ rescue

INSERT INTO feature (area_id, kind, geom)
SELECT mine.id, 'forest',
    st_force3d(st_makeenvelope(20.01, 20.01, 20.02, 20.02, 4326)) FROM mine;

SELECT throws_ok($$SELECT delete_area((SELECT id FROM mine))$$,
    NULL, NULL, 'an area that still holds features is not deleted out from under them');

CREATE TEMP TABLE jid AS
SELECT ensure_job(t.z, t.x, t.y) AS id
FROM tile t WHERE t.z = 14 AND t.dirty LIMIT 1;

SELECT ok(NOT reset_atom((SELECT a.id FROM atom a JOIN jid ON jid.id = a.job_id
                          WHERE a.op = 'assemble')),
          'an atom that has not failed is left alone');

SET LOCAL role = 'postgres';
UPDATE atom SET state = 'failed', attempts = 3
WHERE op = 'assemble' AND job_id = (SELECT id FROM jid);
SET LOCAL role = 'player';

SELECT ok(reset_atom((SELECT a.id FROM atom a JOIN jid ON jid.id = a.job_id
                      WHERE a.op = 'assemble')),
          'a failed atom can be tried again');
SELECT is((SELECT a.state || ' ' || a.attempts FROM atom a JOIN jid ON jid.id = a.job_id
           WHERE a.op = 'assemble'), 'ready 0',
          'it is claimable again, with its attempts forgiven');

ROLLBACK;
