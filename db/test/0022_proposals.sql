-- WP4.3 acceptance — areas, grants, proposals (db/0022_proposals.sql).
--
--   an `edit` grantee's write becomes a proposal and changes nothing;
--   the owner approves -> merge_proposal applies the diff -> the tile is dirty;
--   a `direct_edit` grantee bypasses the whole path;
--   a non-grantee is denied at every step.
BEGIN;
SELECT plan(52);

SET client_min_messages = warning;

-- fixtures -------------------------------------------------------------
CREATE TEMP TABLE ids AS
SELECT
    register('prop-owner@example.com', 'password12') AS owner_id,
    register('prop-direct@example.com', 'password12') AS direct_id,
    register('prop-editor@example.com', 'password12') AS editor_id,
    register('prop-approver@example.com', 'password12') AS approver_id,
    register('prop-stranger@example.com', 'password12') AS stranger_id;
GRANT SELECT ON ids TO player;

-- a1 takes one approval (the schema default), a2 asks its rules for two
INSERT INTO area (id, geom, owner_id, detail, rules)
SELECT '00000000-0000-0000-0000-0000000000a1'::uuid,
       st_geomfromtext('POLYGON((10 46,10.1 46,10.1 46.1,10 46.1,10 46))', 4326),
       ids.owner_id, 14, '{}'::jsonb
FROM ids
UNION ALL
SELECT '00000000-0000-0000-0000-0000000000a2'::uuid,
       st_geomfromtext('POLYGON((11 46,11.1 46,11.1 46.1,11 46.1,11 46))', 4326),
       ids.owner_id, 14, '{"required_approvals": 2}'::jsonb
FROM ids;

INSERT INTO grant_ (area_id, grantee_id, right_)
SELECT a.id, ids.direct_id, 'direct_edit' FROM ids, area a
UNION ALL
SELECT a.id, ids.editor_id, 'edit' FROM ids, area a
UNION ALL
SELECT a.id, ids.approver_id, 'approve' FROM ids, area a;

INSERT INTO artifact (sha256, kind, bytes, algo_version)
VALUES (repeat('a', 64), 'glb', 100, 'canon-v1');
INSERT INTO asset (san, sha256, canon_version, name, category, bbox, tris,
                   tex_bytes, license, creator_id)
SELECT 'SAAAAAAAAAAAA', repeat('a', 64), 1, 'pine', 'tree', '{}'::jsonb, 10, 0,
       'cc0', ids.owner_id
FROM ids;

CREATE TEMP TABLE prop (tag text, id uuid);
GRANT SELECT, INSERT ON prop TO player;

CREATE FUNCTION become(uid uuid, r text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
    EXECUTE format('SET LOCAL request.jwt.claims = %L',
        json_build_object('sub', uid, 'role', r)::text);
END
$$;

CREATE FUNCTION p(t text) RETURNS uuid
LANGUAGE sql STABLE AS $$SELECT id FROM prop WHERE prop.tag = t$$;

-- What the world is before anybody proposes anything, to compare against.
CREATE TEMP TABLE before_proposal AS
SELECT coalesce(sum(expected_version), 0) AS total FROM tile;
GRANT SELECT ON before_proposal TO player;

-- an edit grantee proposes ---------------------------------------------
SET LOCAL ROLE player;
SELECT become(editor_id, 'player') FROM ids;

SELECT throws_ok($$INSERT INTO feature (area_id, kind, geom)
    VALUES ('00000000-0000-0000-0000-0000000000a1', 'road',
            st_geomfromtext('POINTZ(10.01 46.01 0)', 4326))$$,
    '42501', null, 'an edit grantee may not write the world');

-- the "area_id" the diff names is ignored: the row lands in the proposal's
-- area, whatever the author says
INSERT INTO prop VALUES ('f1', propose('00000000-0000-0000-0000-0000000000a1',
    '{"ops": [{"op": "insert", "table": "feature",
               "id": "00000000-0000-0000-0000-0000000000f1",
               "values": {"kind": "road",
                          "area_id": "00000000-0000-0000-0000-0000000000a2",
                          "props": {"lanes": 2},
                          "geom": {"type": "LineString",
                                   "coordinates": [[10.01, 46.01],
                                                   [10.011, 46.011]]}}}]}'::jsonb));

SELECT is((SELECT state FROM proposal WHERE id = p('f1')), 'open',
    'their write becomes an open proposal');
SELECT is((SELECT count(*)::int FROM feature), 0, 'the world is unchanged');
-- The land's own tiles exist (db/0047_landisground.sql); what a proposal must
-- not do is move any of them, because nothing has been agreed yet.
SELECT is((SELECT sum(expected_version) FROM tile), (SELECT total FROM before_proposal),
    'and the proposal moved no tile');

-- a malformed diff is refused where it is made, not where it is merged
SELECT throws_ok($$SELECT propose('00000000-0000-0000-0000-0000000000a1',
    '{"ops": [{"op": "drop", "table": "feature", "id":
      "00000000-0000-0000-0000-0000000000f1"}]}'::jsonb)$$,
    'PT400', null, 'a diff op must be insert, update or delete');
SELECT throws_ok($$SELECT propose('00000000-0000-0000-0000-0000000000a1',
    '[]'::jsonb)$$, 'PT400', null, 'a diff must carry an ops array');
SELECT throws_ok($$SELECT propose('00000000-0000-0000-0000-0000000000a1',
    '{"ops": [{"op": "update", "table": "feature", "values": {}}]}'::jsonb)$$,
    'PT400', null, 'an update must say which row');

-- a non-grantee is denied ----------------------------------------------
SELECT become(stranger_id, 'player') FROM ids;
SELECT throws_ok($$SELECT propose('00000000-0000-0000-0000-0000000000a1',
    '{"ops": []}'::jsonb)$$, '42501', null, 'a stranger may not propose');
SELECT throws_ok(format($$SELECT approve(%L)$$, p('f1')), '42501', null,
    'a stranger may not approve');
SELECT throws_ok(format($$SELECT merge_proposal(%L)$$, p('f1')), 'PT403', null,
    'a stranger may not merge');

-- nor may the author of the proposal -----------------------------------
SELECT become(editor_id, 'player') FROM ids;
SELECT throws_ok(format($$SELECT approve(%L)$$, p('f1')), '42501', null,
    'an edit grantee may not approve');
SELECT throws_ok(format($$SELECT merge_proposal(%L)$$, p('f1')), 'PT403', null,
    'an edit grantee may not merge');

-- the owner approves and merges ----------------------------------------
SELECT become(owner_id, 'player') FROM ids;
SELECT throws_ok(format($$SELECT merge_proposal(%L)$$, p('f1')), 'PT409', null,
    'an unapproved proposal does not merge');
SELECT is(approve(p('f1')), 1, 'the owner approves');
SELECT is(merge_proposal(p('f1')), 1, 'and the merge applies its one op');
SELECT is((SELECT state FROM proposal WHERE id = p('f1')), 'merged',
    'the proposal is merged');
SELECT is((SELECT area_id FROM feature WHERE id = '00000000-0000-0000-0000-0000000000f1'),
    '00000000-0000-0000-0000-0000000000a1'::uuid,
    'the row lands in the proposal area, not the one the diff named');
SELECT is((SELECT props ->> 'lanes' FROM feature
           WHERE id = '00000000-0000-0000-0000-0000000000f1'), '2',
    'with the values the diff carried');

-- Invariant 4: the feature trigger did this, merge_proposal did not.
SELECT ok((SELECT t.dirty FROM tile t
           WHERE t.z = 14 AND t.x = tile_x(10.0105, 14) AND t.y = tile_y(46.0105, 14)),
    'the merged write marked its tile dirty');
SELECT is((SELECT count(DISTINCT z)::int FROM tile), 5,
    'every zoom up to the area detail is dirty');

SELECT throws_ok(format($$SELECT merge_proposal(%L)$$, p('f1')), 'PT409', null,
    'a merged proposal does not merge twice');
SELECT throws_ok(format($$SELECT approve(%L)$$, p('f1')), 'PT409', null,
    'and takes no further approvals');
SELECT throws_ok(
    $$SELECT merge_proposal('00000000-0000-0000-0000-0000000000ff')$$,
    'PT404', null, 'a proposal that does not exist does not merge');

-- two approvals, three ops, in order -----------------------------------
SELECT become(editor_id, 'player') FROM ids;
INSERT INTO prop VALUES ('i1', propose('00000000-0000-0000-0000-0000000000a2',
    '{"ops": [{"op": "insert", "table": "instance",
               "id": "00000000-0000-0000-0000-0000000000e1",
               "values": {"san": "SAAAAAAAAAAAA", "lon": 11.05, "lat": 46.05}},
              {"op": "update", "table": "instance",
               "id": "00000000-0000-0000-0000-0000000000e1",
               "values": {"scale": 3, "h": 12}},
              {"op": "update", "table": "feature",
               "id": "00000000-0000-0000-0000-0000000000f1",
               "values": {"props": {"lanes": 99}}}]}'::jsonb));

SELECT become(approver_id, 'player') FROM ids;
SELECT is(approve(p('i1')), 1, 'an approve grantee approves');
SELECT throws_ok(format($$SELECT merge_proposal(%L)$$, p('i1')), 'PT409', null,
    'one approval is not the two this area asks its rules for');
SELECT become(owner_id, 'player') FROM ids;
SELECT is(approve(p('i1')), 2, 'the owner is the second approval');
SELECT is(merge_proposal(p('i1')), 3, 'and all three ops are applied');
SELECT is((SELECT scale FROM instance WHERE id = '00000000-0000-0000-0000-0000000000e1'),
    3::real, 'the update after the insert won, so ops ran in order');
SELECT is((SELECT props ->> 'lanes' FROM feature
           WHERE id = '00000000-0000-0000-0000-0000000000f1'), '2',
    'a diff cannot reach a row outside its own area');

-- an approve grantee merges a delete ------------------------------------
SELECT become(editor_id, 'player') FROM ids;
INSERT INTO prop VALUES ('d1', propose('00000000-0000-0000-0000-0000000000a1',
    '{"ops": [{"op": "delete", "table": "feature",
               "id": "00000000-0000-0000-0000-0000000000f1"}]}'::jsonb));
SELECT become(approver_id, 'player') FROM ids;
SELECT is(approve(p('d1')), 1, 'an approve grantee is enough for this area');
SELECT is(merge_proposal(p('d1')), 1, 'and may merge without the owner');
SELECT isnt((SELECT deleted_at FROM feature
             WHERE id = '00000000-0000-0000-0000-0000000000f1'),
    null::timestamptz, 'a delete op retires the row rather than dropping it');
SELECT ok((SELECT t.expected_version > 1 FROM tile t
           WHERE t.z = 14 AND t.x = tile_x(10.0105, 14) AND t.y = tile_y(46.0105, 14)),
    'and dirtied the tile again');

-- direct_edit bypasses the whole path -----------------------------------
SELECT become(direct_id, 'player') FROM ids;
SELECT lives_ok($$INSERT INTO instance (area_id, san, lon, lat)
    VALUES ('00000000-0000-0000-0000-0000000000a1', 'SAAAAAAAAAAAA', 10.011, 46.011)$$,
    'a direct_edit grantee writes the world itself');
SELECT is((SELECT count(*)::int FROM proposal), 3, 'and makes no proposal');
SELECT ok((SELECT t.dirty FROM tile t
           WHERE t.z = 14 AND t.x = tile_x(10.011, 14) AND t.y = tile_y(46.011, 14)),
    'their write dirties tiles the same way');

-- grants, rules and the two lists the panel reads (WP4.3's UI half) --------

SELECT become(owner_id, 'player') FROM ids;
SELECT lives_ok($$SELECT set_grant('00000000-0000-0000-0000-0000000000a1',
    'prop-stranger@example.com', 'edit')$$, 'the owner grants by email');
SELECT is((SELECT count(*)::int FROM grant_ g
           WHERE g.area_id = '00000000-0000-0000-0000-0000000000a1'
             AND g.grantee_id = (SELECT stranger_id FROM ids)), 1,
          'and the grant is there');
SELECT is(jsonb_array_length(area_grants('00000000-0000-0000-0000-0000000000a1')), 4,
          'the panel lists every grant on the area');
SELECT isnt(area_grants('00000000-0000-0000-0000-0000000000a1') -> 0 ->> 'email', null,
            'the owner sees the addresses they typed');
SELECT throws_ok($$SELECT set_grant('00000000-0000-0000-0000-0000000000a1',
    'nobody@example.com', 'edit')$$, 'PT404', null,
    'granting to an address with no account is refused');
SELECT lives_ok($$SELECT revoke_grant('00000000-0000-0000-0000-0000000000a1',
    (SELECT stranger_id FROM ids), 'edit')$$, 'and the owner takes it back');
SELECT is((SELECT count(*)::int FROM grant_ g
           WHERE g.area_id = '00000000-0000-0000-0000-0000000000a1'
             AND g.grantee_id = (SELECT stranger_id FROM ids)), 0, 'it is gone');

SELECT is(set_required_approvals('00000000-0000-0000-0000-0000000000a1', 3)
              ->> 'required_approvals', '3', 'the owner sets the rule');
SELECT throws_ok($$SELECT set_required_approvals(
    '00000000-0000-0000-0000-0000000000a1', 0)$$, 'PT400', null,
    'and cannot set it below one');
SELECT is(set_required_approvals('00000000-0000-0000-0000-0000000000a1', 1)
              ->> 'required_approvals', '1', 'put back for the rest of the file');

-- Nobody but the owner moves a grant, whatever else they may do in the area.
SELECT become(editor_id, 'player') FROM ids;
SELECT throws_ok($$SELECT set_grant('00000000-0000-0000-0000-0000000000a1',
    'prop-stranger@example.com', 'edit')$$, 'PT403', null,
    'an edit grantee cannot grant');
SELECT is(area_grants('00000000-0000-0000-0000-0000000000a1') -> 0 ->> 'email', null,
          'and does not see the addresses');

-- my_proposals is what the panel lists: mine to answer for, or mine to review.
-- Everything proposed above has been merged by now, so this needs a fresh one.
CREATE TEMP TABLE fresh AS
SELECT propose('00000000-0000-0000-0000-0000000000a1',
    '{"ops":[{"op":"insert","table":"instance",
              "values":{"san":"SAAAAAAAAAAAA","lon":10.012,"lat":46.012}}]}'::jsonb) AS id;
GRANT SELECT ON fresh TO player;
SELECT is((SELECT count(*)::int FROM proposal p
           WHERE p.id = (SELECT id FROM fresh) AND p.state = 'open'), 1,
          'the editor has one more open proposal');

SELECT become(approver_id, 'player') FROM ids;
SELECT ok((SELECT count(*) FROM jsonb_array_elements(my_proposals('open'))) >= 1,
          'an approver sees the open proposals of areas they review');
SELECT is(my_proposals('open') -> 0 ->> 'may_approve', 'true', 'and may approve them');
SELECT become(stranger_id, 'player') FROM ids;
SELECT is(jsonb_array_length(my_proposals('open')), 0,
          'a stranger has no proposals to see');

RESET ROLE;
SELECT * FROM finish();
ROLLBACK;
