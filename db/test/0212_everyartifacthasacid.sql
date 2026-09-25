-- Every file has a CID beside its sha256, recorded by the store (db/0212).
BEGIN;
SELECT plan(7);

SET client_min_messages = warning;
SET LOCAL request.jwt.claims = '{"role":"player","sub":"00000000-0000-0000-0000-000000000210"}';
SELECT throws_like($$SELECT record_cid(repeat('1', 64), 'bafkreiaaaaaaaaaaaaaaaaaaaaaa')$$,
    '%only the file store%', 'a player does not say what a file''s CID is');

SET LOCAL request.jwt.claims = '{"role":"admin"}';
SELECT is(record_cid(repeat('1', 64), 'bafkreiaaaaaaaaaaaaaaaaaaaaaa'),
    'bafkreiaaaaaaaaaaaaaaaaaaaaaa', 'the store records it once the bytes are in');
SELECT is(record_cid(repeat('1', 64), 'bafkreiaaaaaaaaaaaaaaaaaaaaaa'),
    'bafkreiaaaaaaaaaaaaaaaaaaaaaa', 'and again, which changes nothing');
SELECT throws_like($$SELECT record_cid(repeat('1', 64), 'bafkreibbbbbbbbbbbbbbbbbbbbbb')$$,
    '%already has CID%', 'a second, different CID is a broken importer, and refused');

INSERT INTO artifact (sha256, kind, bytes, algo_version)
VALUES (repeat('1', 64), 'glb', 10, 'canon-v2');
SELECT is((SELECT cid FROM artifact WHERE sha256 = repeat('1', 64)),
    'bafkreiaaaaaaaaaaaaaaaaaaaaaa', 'an artifact registered after its bytes takes the CID');

INSERT INTO artifact (sha256, kind, bytes, algo_version)
VALUES (repeat('2', 64), 'glb', 10, 'canon-v2');
SELECT record_cid(repeat('2', 64), 'bafkreicccccccccccccccccccccc');
SELECT is((SELECT cid FROM artifact WHERE sha256 = repeat('2', 64)),
    'bafkreicccccccccccccccccccccc', 'and one registered before gets it when it comes');
SELECT is(cid_of(repeat('2', 64)), 'bafkreicccccccccccccccccccccc',
    'cid_of answers by sha256');

SELECT * FROM finish();
ROLLBACK;
