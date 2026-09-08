-- WP0.2 acceptance: every table/column/index from ARCHITECTURE §3 exists, and
-- the ledger is append-only for role player.
BEGIN;
SELECT plan(78);

-- tables ---------------------------------------------------------------
SELECT has_table('public', t, 'table ' || t) FROM unnest(ARRAY[
    'artifact', 'account', 'ledger', 'area', 'grant_', 'feature', 'instance',
    'proposal', 'approval', 'asset', 'asset_right', 'tile', 'job', 'atom',
    'worker', 'worker_op_stats', 'verification'
]) AS t;

SELECT has_view('public', 'balance', 'view balance');
SELECT has_domain('public', 'zoom', 'domain zoom');

-- columns --------------------------------------------------------------
SELECT columns_are('public', 'artifact', ARRAY[
    'sha256', 'kind', 'bytes', 'algo_version', 'created_by', 'created_at']);
SELECT columns_are('public', 'account', ARRAY['id', 'owner_id']);
SELECT columns_are('public', 'ledger', ARRAY[
    'id', 'at', 'debit', 'credit', 'amount', 'ref']);
SELECT columns_are('public', 'area', ARRAY[
    'id', 'geom', 'owner_id', 'detail', 'rules', 'created_at']);
SELECT columns_are('public', 'grant_', ARRAY['area_id', 'grantee_id', 'right_']);
SELECT columns_are('public', 'feature', ARRAY[
    'id', 'area_id', 'kind', 'geom', 'props', 'rev', 'deleted_at']);
SELECT columns_are('public', 'instance', ARRAY[
    'id', 'area_id', 'san', 'lon', 'lat', 'h', 'yaw', 'pitch', 'roll', 'scale',
    'props', 'rev', 'deleted_at', 'geom']);
SELECT columns_are('public', 'proposal', ARRAY[
    'id', 'area_id', 'author_id', 'state', 'diff', 'created_at']);
SELECT columns_are('public', 'approval', ARRAY['proposal_id', 'reviewer_id', 'at']);
SELECT columns_are('public', 'asset', ARRAY[
    'san', 'sha256', 'canon_version', 'name', 'category', 'bbox', 'tris',
    'tex_bytes', 'license', 'price', 'editions', 'issued', 'creator_id',
    'created_at']);
SELECT columns_are('public', 'asset_right', ARRAY[
    'san', 'holder_id', 'acquired_at', 'ref']);
SELECT columns_are('public', 'tile', ARRAY[
    'z', 'x', 'y', 'dirty', 'expected_version', 'published_version',
    'sog_sha256', 'manifest', 'published_at', 'published_by']);
SELECT columns_are('public', 'job', ARRAY[
    'id', 'z', 'x', 'y', 'target_version', 'bounty', 'state', 'created_at']);
SELECT columns_are('public', 'atom', ARRAY[
    'id', 'job_id', 'atom_hash', 'op', 'algo_version', 'deps', 'inputs',
    'params', 'seed', 'state', 'worker_id', 'claimed_at', 'heartbeat_at',
    'result', 'output_sha256', 'attempts']);
SELECT columns_are('public', 'worker', ARRAY[
    'id', 'user_id', 'caps', 'trust', 'last_seen']);
SELECT columns_are('public', 'worker_op_stats', ARRAY['worker_id', 'op', 'ok', 'bad']);
SELECT columns_are('public', 'verification', ARRAY[
    'atom_id', 'verifier_worker_id', 'kind', 'passed', 'metrics', 'at']);

-- primary keys ---------------------------------------------------------
SELECT col_is_pk('public', 'artifact', 'sha256', 'artifact pk');
SELECT col_is_pk('public', 'asset', 'san', 'asset pk');
SELECT col_is_pk('public', 'tile', ARRAY['z', 'x', 'y'], 'tile pk');
SELECT col_is_pk('public', 'grant_', ARRAY['area_id', 'grantee_id', 'right_'], 'grant_ pk');
SELECT col_is_pk('public', 'approval', ARRAY['proposal_id', 'reviewer_id'], 'approval pk');
SELECT col_is_pk('public', 'asset_right', ARRAY['san', 'holder_id'], 'asset_right pk');
SELECT col_is_pk('public', 'worker_op_stats', ARRAY['worker_id', 'op'], 'worker_op_stats pk');

-- foreign keys ---------------------------------------------------------
SELECT col_is_fk('public', 'ledger', 'debit', 'ledger.debit fk');
SELECT col_is_fk('public', 'ledger', 'credit', 'ledger.credit fk');
SELECT col_is_fk('public', 'feature', 'area_id', 'feature.area_id fk');
SELECT col_is_fk('public', 'instance', 'area_id', 'instance.area_id fk');
SELECT col_is_fk('public', 'instance', 'san', 'instance.san fk');
SELECT col_is_fk('public', 'asset', 'sha256', 'asset.sha256 fk');
SELECT col_is_fk('public', 'tile', 'sog_sha256', 'tile.sog_sha256 fk');
SELECT col_is_fk('public', 'job', ARRAY['z', 'x', 'y'], 'job -> tile fk');
SELECT col_is_fk('public', 'atom', 'job_id', 'atom.job_id fk');
SELECT col_is_fk('public', 'atom', 'worker_id', 'atom.worker_id fk');
SELECT col_is_fk('public', 'verification', 'atom_id', 'verification.atom_id fk');

-- uniques and indexes --------------------------------------------------
SELECT col_is_unique('public', 'ledger', 'ref', 'UNIQUE(ledger.ref)');
SELECT col_is_unique('public', 'atom', 'atom_hash', 'UNIQUE(atom.atom_hash)');
SELECT col_is_unique('public', 'job', ARRAY['z', 'x', 'y', 'target_version'],
    'UNIQUE(job.z,x,y,target_version)');
SELECT col_is_unique('public', 'asset_right', 'ref', 'UNIQUE(asset_right.ref)');

SELECT has_index('public', 'area', 'area_geom_idx', 'GiST on area.geom');
SELECT has_index('public', 'feature', 'feature_geom_idx', 'GiST on feature.geom');
SELECT has_index('public', 'instance', 'instance_geom_idx', 'GiST on instance.geom');
SELECT index_is_type('public', 'area', 'area_geom_idx', 'gist');
SELECT index_is_type('public', 'feature', 'feature_geom_idx', 'gist');
SELECT index_is_type('public', 'instance', 'instance_geom_idx', 'gist');
SELECT has_index('public', 'atom', 'atom_state_op_idx', ARRAY['state', 'op'],
    'index on atom(state, op)');
SELECT has_index('public', 'tile', 'tile_dirty_idx', 'partial index on tile.dirty');

-- every geometry column is GiST-indexed (deliverable: "all geometry")
SELECT is_empty($$
    SELECT c.table_name || '.' || c.column_name
    FROM information_schema.columns c
    WHERE c.table_schema = 'public' AND c.udt_name = 'geometry'
      AND NOT EXISTS (
          SELECT 1
          FROM pg_index i
          JOIN pg_class t ON t.oid = i.indrelid
          JOIN pg_am am ON am.oid = (SELECT relam FROM pg_class WHERE oid = i.indexrelid)
          JOIN pg_attribute a
            ON a.attrelid = t.oid AND a.attnum = ANY (i.indkey)
          WHERE t.relname = c.table_name AND a.attname = c.column_name
            AND am.amname = 'gist')
$$, 'every geometry column has a GiST index');

-- checks ---------------------------------------------------------------
SELECT throws_ok($$INSERT INTO tile (z, x, y) VALUES (7, 1, 1)$$, NULL,
    'odd zoom rejected');
SELECT throws_ok($$INSERT INTO tile (z, x, y) VALUES (6, 64, 1)$$, NULL,
    'x out of range rejected');
SELECT lives_ok($$INSERT INTO tile (z, x, y) VALUES (6, 33, 22)$$,
    'even zoom in range accepted');
SELECT throws_ok(
    $$UPDATE tile SET published_version = 5 WHERE z = 6$$, NULL,
    'published_version cannot exceed expected_version (Invariant 3)');

-- ledger is append-only ------------------------------------------------
INSERT INTO account (id, owner_id)
VALUES ('11111111-1111-1111-1111-111111111111', NULL),
       ('22222222-2222-2222-2222-222222222222', NULL);
INSERT INTO ledger (debit, credit, amount, ref)
VALUES ('11111111-1111-1111-1111-111111111111',
        '22222222-2222-2222-2222-222222222222', 10, 'test:1');

SELECT is((SELECT amount FROM balance
           WHERE account_id = '22222222-2222-2222-2222-222222222222'),
          10::numeric, 'balance credits');
SELECT is((SELECT amount FROM balance
           WHERE account_id = '11111111-1111-1111-1111-111111111111'),
          -10::numeric, 'balance debits');

SELECT throws_ok($$INSERT INTO ledger (debit, credit, amount, ref)
    VALUES ('11111111-1111-1111-1111-111111111111',
            '22222222-2222-2222-2222-222222222222', 1, 'test:1')$$,
    '23505', NULL, 'duplicate ledger.ref rejected');

SET ROLE player;
SELECT throws_ok($$UPDATE ledger SET amount = 999$$, '42501', NULL,
    'player cannot UPDATE ledger');
SELECT throws_ok($$DELETE FROM ledger$$, '42501', NULL,
    'player cannot DELETE from ledger');
RESET ROLE;

SELECT throws_ok($$UPDATE ledger SET amount = 999$$, 'P0001', NULL,
    'ledger UPDATE blocked by trigger even for the owner');
SELECT throws_ok($$DELETE FROM ledger$$, 'P0001', NULL,
    'ledger DELETE blocked by trigger even for the owner');

SELECT * FROM finish();
ROLLBACK;
