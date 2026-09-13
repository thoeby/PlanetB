-- The QGIS project knows when it is old (db/0078_theprojectgoesoutofdate.sql).
BEGIN;
SELECT plan(6);

CREATE TEMP TABLE who AS SELECT register('ben78@example.com', 'password12') AS ben;
GRANT SELECT ON who TO player;
SELECT set_config('request.jwt.claims',
    json_build_object('sub', ben, 'role', 'player')::text, true) FROM who;

SELECT ok((project_state() ->> 'took') IS null,
          'somebody who never downloaded one has nothing to be out of date');
SELECT is((project_state() ->> 'stale')::boolean, false,
          'and is not told it is');

CREATE TEMP TABLE took AS SELECT took_project() AS rev;
GRANT SELECT ON took TO player;
SELECT is((project_state() ->> 'stale')::boolean, false,
          'a project taken at this revision is current');

-- Somebody adds a word to the vocabulary. Who is allowed to is
-- db/0040_properties.sql's business; what matters here is that the revision
-- moves and the project on disk is told.
SET LOCAL role = 'postgres';
INSERT INTO property (kind, name, label, type, choices, required, ordering)
VALUES ('forest', 'managed', 'Managed', 'choice',
        ARRAY['managed', 'wild'], false, 50);
SET LOCAL role = 'player';

SELECT cmp_ok((SELECT (project_state() ->> 'rev')::bigint), '>',
              (SELECT rev FROM took), 'the world''s vocabulary moved on');
SELECT is((project_state() ->> 'stale')::boolean, true,
          'so the project on disk is out of date');

SELECT ok(took_project() = (project_state() ->> 'rev')::bigint,
          'and downloading it again catches up');

SELECT * FROM finish();
ROLLBACK;
