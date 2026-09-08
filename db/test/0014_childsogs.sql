-- child_sogs names the children a merge is built from, and a published child
-- has to appear in it (db/0014_childsogs.sql).
BEGIN;
SELECT plan(4);

SET client_min_messages = warning;

INSERT INTO artifact (sha256, kind, bytes, algo_version)
VALUES (repeat('7', 64), 'sog', 10, 'sog-v1');
INSERT INTO tile (z, x, y, dirty, expected_version, published_version, sog_sha256)
VALUES (10, 532, 361, false, 1, 1, repeat('7', 64)),
       (10, 535, 363, false, 1, 0, null);

SELECT is(jsonb_array_length(child_sogs(8, 133, 90)), 16,
          'sixteen slots, one per grandchild');
SELECT ok(child_sogs(8, 133, 90) @> to_jsonb(repeat('7', 64)),
          'a published child is named');
SELECT is((child_sogs(8, 133, 90) ->> 0), '',
          'an unpublished one is an empty string, not a missing entry');
SELECT is(child_sogs(8, 134, 90), child_sogs(8, 134, 90),
          'and the answer is stable, which is what atom_hash needs');

SELECT * FROM finish();
ROLLBACK;
