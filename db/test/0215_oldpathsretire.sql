-- A GET of an old path is sent on to the file's CID (db/0215).
BEGIN;
SELECT plan(3);

SET client_min_messages = warning;
SET LOCAL request.jwt.claims = '{"role":"admin"}';
SELECT record_cid(repeat('4', 64), 'bafkreiddddddddddddddddddddddddd');

SELECT file_at(repeat('4', 64), 'glb');
SELECT is(current_setting('response.status'), '302', 'a file with a CID is sent on');
SELECT is(current_setting('response.headers')::jsonb -> 0 ->> 'Location',
    '/ipfs/bafkreiddddddddddddddddddddddddd?filename=' || repeat('4', 64) || '.glb',
    'to the CID, with the name it was asked by');
SELECT file_at(repeat('5', 64), 'glb');
SELECT is(current_setting('response.status'), '404', 'one without is not, and the store serves it');

SELECT * FROM finish();
ROLLBACK;
