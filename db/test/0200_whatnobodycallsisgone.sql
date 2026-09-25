-- Functions nothing calls are gone (db/0200).
BEGIN;
SELECT plan(6);

SELECT hasnt_function('public', 'approve_tile', 'approve_tile is gone');
SELECT hasnt_function('api', 'approve_tile', 'and its api wrapper');
SELECT hasnt_function('public', 'refuse_tile', 'refuse_tile is gone');
SELECT hasnt_function('public', 'my_candidates', 'my_candidates is gone');
SELECT hasnt_function('public', 'height_edit_rev', 'height_edit_rev is gone');
SELECT hasnt_function('public', 'inside_ground', 'inside_ground is gone');

SELECT * FROM finish();
ROLLBACK;
