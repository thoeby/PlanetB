-- WP0.4 acceptance — row-level security.
--
-- 12 denial cases:
--   D1  anon INSERT feature
--   D2  anon UPDATE feature                       (no grant: hard denial)
--   D3  stranger INSERT feature
--   D4  stranger UPDATE feature                   (silently matches no row)
--   D5  stranger DELETE feature                   (silently matches no row)
--   D6  'edit' grantee INSERT feature             (needs direct_edit)
--   D7  'approve' grantee INSERT instance
--   D8  stranger INSERT proposal
--   D9  'edit' grantee INSERT proposal for another author_id
--   D10 'edit' grantee INSERT approval            (lacks 'approve')
--   D11 player INSERT tile                        (definer functions only)
--   D12 player INSERT artifact                    (definer functions only)
--
-- 6 allow cases:
--   A1 anon SELECT tile
--   A2 anon SELECT asset (catalog)
--   A3 area owner INSERT feature
--   A4 'direct_edit' grantee INSERT instance
--   A5 'edit' grantee INSERT proposal for themselves
--   A6 'approve' grantee INSERT approval
BEGIN;
SELECT plan(24);

-- fixtures -------------------------------------------------------------
CREATE TEMP TABLE ids AS
SELECT
    register('owner@example.com', 'password12') AS owner_id,
    register('direct@example.com', 'password12') AS direct_id,
    register('editor@example.com', 'password12') AS editor_id,
    register('approver@example.com', 'password12') AS approver_id,
    register('stranger@example.com', 'password12') AS stranger_id;
GRANT SELECT ON ids TO anon, player;

INSERT INTO area (id, geom, owner_id, detail)
SELECT
    '00000000-0000-0000-0000-0000000000a1',
    st_geomfromtext('POLYGON((7 46,8 46,8 47,7 47,7 46))', 4326),
    ids.owner_id, 14
FROM ids;

INSERT INTO grant_ (area_id, grantee_id, right_)
SELECT '00000000-0000-0000-0000-0000000000a1'::uuid, ids.direct_id, 'direct_edit' FROM ids
UNION ALL
SELECT '00000000-0000-0000-0000-0000000000a1'::uuid, ids.editor_id, 'edit' FROM ids
UNION ALL
SELECT '00000000-0000-0000-0000-0000000000a1'::uuid, ids.approver_id, 'approve' FROM ids;

INSERT INTO artifact (sha256, kind, bytes, algo_version)
VALUES (repeat('a', 64), 'glb', 100, 'canon-v1');
INSERT INTO asset (san, sha256, canon_version, name, category, bbox, tris,
                   tex_bytes, license, creator_id)
SELECT 'SAAAAAAAAAAAA', repeat('a', 64), 1, 'pine', 'tree', '{}'::jsonb, 10, 0,
       'cc0', ids.owner_id
FROM ids;

INSERT INTO feature (id, area_id, kind, geom)
VALUES ('00000000-0000-0000-0000-0000000000f1',
        '00000000-0000-0000-0000-0000000000a1', 'forest',
        st_geomfromtext('POLYGONZ((7.1 46.1 0,7.2 46.1 0,7.2 46.2 0,7.1 46.2 0,7.1 46.1 0))', 4326));

INSERT INTO proposal (id, area_id, author_id, diff)
SELECT '00000000-0000-0000-0000-0000000000c1'::uuid,
       '00000000-0000-0000-0000-0000000000a1'::uuid, ids.editor_id, '[]'::jsonb
FROM ids;

-- Row-level security filters UPDATE/DELETE silently, so denial is "no row
-- matched", not an error. This helper reports how many rows a statement moved.
CREATE FUNCTION touched(sql text) RETURNS int
LANGUAGE plpgsql AS $$
DECLARE
    n int;
BEGIN
    EXECUTE sql;
    GET DIAGNOSTICS n = row_count;
    RETURN n;
END
$$;

CREATE FUNCTION become(uid uuid, r text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
    EXECUTE format('SET LOCAL request.jwt.claims = %L',
        json_build_object('sub', uid, 'role', r)::text);
END
$$;

-- D1..D2: anon ---------------------------------------------------------
SET LOCAL ROLE anon;
SET LOCAL request.jwt.claims = '{}';
SELECT throws_ok($$INSERT INTO feature (area_id, kind, geom)
    VALUES ('00000000-0000-0000-0000-0000000000a1', 'road',
            st_geomfromtext('POINTZ(7.1 46.1 0)', 4326))$$,
    '42501', NULL, 'D1 anon INSERT feature denied');
SELECT throws_ok($$UPDATE feature SET props = '{"x":1}'::jsonb$$, '42501', NULL,
    'D2 anon UPDATE feature denied (no grant at all)');

-- A1..A2: public reads -------------------------------------------------
SELECT ok((SELECT count(*) FROM tile) > 0, 'A1 anon may SELECT tile');
SELECT is((SELECT count(*)::int FROM asset), 1, 'A2 anon may SELECT the catalog');
SELECT is((SELECT count(*)::int FROM feature), 1, 'anon may SELECT the world');
SELECT is((SELECT count(*)::int FROM ledger), 0, 'anon sees no ledger rows');
RESET ROLE;

-- D3..D5: stranger -----------------------------------------------------
SET LOCAL ROLE player;
SELECT become(stranger_id, 'player') FROM ids;
SELECT throws_ok($$INSERT INTO feature (area_id, kind, geom)
    VALUES ('00000000-0000-0000-0000-0000000000a1', 'road',
            st_geomfromtext('POINTZ(7.1 46.1 0)', 4326))$$,
    '42501', NULL, 'D3 stranger INSERT feature denied');
SELECT is(touched($$UPDATE feature SET props = '{"x":1}'::jsonb$$), 0,
    'D4 stranger UPDATE feature touches no row');
SELECT is(touched($$DELETE FROM feature$$), 0,
    'D5 stranger DELETE feature touches no row');
SELECT throws_ok($$INSERT INTO proposal (area_id, author_id, diff)
    SELECT '00000000-0000-0000-0000-0000000000a1'::uuid, current_user_id(), '[]'::jsonb$$,
    '42501', NULL, 'D8 stranger INSERT proposal denied');

-- D11..D12: tables that only definer functions write -------------------
SELECT throws_ok($$INSERT INTO tile (z, x, y) VALUES (6, 1, 1)$$,
    '42501', NULL, 'D11 player INSERT tile denied');
SELECT throws_ok($$INSERT INTO artifact (sha256, kind, bytes, algo_version)
    VALUES (repeat('b', 64), 'sog', 1, 'sog-v1')$$,
    '42501', NULL, 'D12 player INSERT artifact denied');
SELECT throws_ok($$INSERT INTO ledger (debit, credit, amount, ref)
    SELECT id, id, 1, 'x' FROM account LIMIT 1$$,
    '42501', NULL, 'player INSERT ledger denied');
SELECT throws_ok($$INSERT INTO atom (job_id, atom_hash, op, algo_version)
    VALUES (1, repeat('c', 64), 'merge', 'merge-v1')$$,
    '42501', NULL, 'player INSERT atom denied');

-- D6, D9, D10, A5: 'edit' grantee --------------------------------------
SELECT become(editor_id, 'player') FROM ids;
SELECT throws_ok($$INSERT INTO feature (area_id, kind, geom)
    VALUES ('00000000-0000-0000-0000-0000000000a1', 'road',
            st_geomfromtext('POINTZ(7.1 46.1 0)', 4326))$$,
    '42501', NULL, 'D6 edit grantee INSERT feature denied (needs direct_edit)');
SELECT throws_ok($$INSERT INTO proposal (area_id, author_id, diff)
    VALUES ('00000000-0000-0000-0000-0000000000a1',
            '00000000-0000-0000-0000-0000000000ff', '[]'::jsonb)$$,
    '42501', NULL, 'D9 proposal for another author_id denied');
SELECT throws_ok($$INSERT INTO approval (proposal_id, reviewer_id)
    SELECT '00000000-0000-0000-0000-0000000000c1'::uuid, current_user_id()$$,
    '42501', NULL, 'D10 edit grantee INSERT approval denied');
SELECT lives_ok($$INSERT INTO proposal (area_id, author_id, diff)
    SELECT '00000000-0000-0000-0000-0000000000a1'::uuid, current_user_id(), '[]'::jsonb$$,
    'A5 edit grantee INSERT proposal for themselves');

-- D7, A4: 'direct_edit' vs 'approve' grantee ----------------------------
SELECT become(approver_id, 'player') FROM ids;
SELECT throws_ok($$INSERT INTO instance (area_id, san, lon, lat)
    VALUES ('00000000-0000-0000-0000-0000000000a1', 'SAAAAAAAAAAAA', 7.1, 46.1)$$,
    '42501', NULL, 'D7 approve grantee INSERT instance denied');
SELECT lives_ok($$INSERT INTO approval (proposal_id, reviewer_id)
    SELECT '00000000-0000-0000-0000-0000000000c1'::uuid, current_user_id()$$,
    'A6 approve grantee INSERT approval');

SELECT become(direct_id, 'player') FROM ids;
SELECT lives_ok($$INSERT INTO instance (area_id, san, lon, lat)
    VALUES ('00000000-0000-0000-0000-0000000000a1', 'SAAAAAAAAAAAA', 7.1, 46.1)$$,
    'A4 direct_edit grantee INSERT instance');
SELECT is(touched($$UPDATE feature SET props = '{"x":1}'::jsonb$$), 1,
    'direct_edit grantee UPDATE feature');

-- A3: owner ------------------------------------------------------------
SELECT become(owner_id, 'player') FROM ids;
SELECT lives_ok($$INSERT INTO feature (area_id, kind, geom)
    VALUES ('00000000-0000-0000-0000-0000000000a1', 'road',
            st_geomfromtext('LINESTRINGZ(7.1 46.1 0,7.2 46.2 0)', 4326))$$,
    'A3 area owner INSERT feature');
SELECT is((SELECT count(*)::int FROM account), 1, 'owner sees only their own account');

RESET ROLE;
SELECT * FROM finish();
ROLLBACK;
