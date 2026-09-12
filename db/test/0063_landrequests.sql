-- Asking for land, and being told you have it (db/0063_landrequests.sql).
BEGIN;
SELECT plan(14);

INSERT INTO auth.user (id, email, pw_hash, role, name) VALUES
('00000000-0000-0000-0000-00000000f401', 'anna@example.com', 'x', 'admin', 'Anna'),
('00000000-0000-0000-0000-00000000f402', 'ben@example.com', 'x', 'player', 'Ben'),
('00000000-0000-0000-0000-00000000f403', 'cara@example.com', 'x', 'player', 'Cara');
DELETE FROM ground;
INSERT INTO ground (geoserver_url, coverage, extent, set_by)
VALUES ('http://localhost:8081/geoserver', 'splatworld:visp',
        st_makeenvelope(7.8545, 46.2759, 7.9085, 46.3119, world_srid()),
        '00000000-0000-0000-0000-00000000f401');

CREATE FUNCTION acting_as(uid uuid, r text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
    EXECUTE format('SET LOCAL request.jwt.claims = %L',
        json_build_object('sub', uid, 'role', r)::text);
    EXECUTE format('SET LOCAL ROLE %I', r);
END
$$;

-- Ben asks -----------------------------------------------------------------
SELECT acting_as('00000000-0000-0000-0000-00000000f402', 'player');
SELECT is(request_land('near Visp, ~2 ha') ->> 'state', 'open', 'Ben asks for land');
SELECT is(land_requests('open') -> 0 ->> 'who', 'Ben', 'by name');
SELECT is(jsonb_array_length(land_requests('open')), 1,
          'and sees his own request waiting');

-- Asking twice is the same request, said again, not a second one.
SELECT lives_ok($$SELECT request_land('near Visp, ~3 ha')$$, 'Ben says it again');

RESET ROLE;
SELECT is((SELECT count(*)::int FROM land_request), 1, 'still one request');
-- This world may hold admins somebody else's fixture made, so count Anna's.
SELECT is((SELECT count(*)::int FROM notification
           WHERE kind = 'land_requested'
             AND user_id = '00000000-0000-0000-0000-00000000f401'), 2,
          'both askings told the admin');

-- Cara is not an admin, whatever she calls -----------------------------------
SELECT acting_as('00000000-0000-0000-0000-00000000f403', 'player');
-- Twice refused: a player has no execute on it at all, and the function says
-- so itself to anybody who does (an admin whose role changed under them).
SELECT throws_like($$SELECT assign_land(
    (SELECT id FROM land_request ORDER BY created_at LIMIT 1),
    '{"type":"Polygon","coordinates":[[[7.876,46.291],[7.883,46.291],
      [7.883,46.296],[7.876,46.296],[7.876,46.291]]]}'::jsonb, 'Mine now')$$,
    '%permission denied for function assign_land%',
    'a player cannot assign land');

-- Anna assigns ---------------------------------------------------------------
SELECT acting_as('00000000-0000-0000-0000-00000000f401', 'admin');
SELECT throws_like($$SELECT assign_land(
    (SELECT id FROM land_request ORDER BY created_at LIMIT 1),
    '{"type":"Polygon","coordinates":[[[46.291,7.876],[46.291,7.883],
      [46.296,7.883],[46.296,7.876],[46.291,7.876]]]}'::jsonb, 'Ben''s field')$$,
    '%longitude and latitude swapped%',
    'land with its coordinates the wrong way round cannot be made');

SELECT is(assign_land(
    (SELECT id FROM land_request ORDER BY created_at LIMIT 1),
    '{"type":"Polygon","coordinates":[[[7.876,46.291],[7.883,46.291],
      [7.883,46.296],[7.876,46.296],[7.876,46.291]]]}'::jsonb,
    'Ben''s field') ->> 'who', 'Ben', 'Anna hands it to Ben');

RESET ROLE;
SELECT is((SELECT owner_id FROM area ORDER BY created_at DESC LIMIT 1),
          '00000000-0000-0000-0000-00000000f402'::uuid,
          'the land is Ben''s, not the admin''s');

-- Ben is told ----------------------------------------------------------------
SELECT acting_as('00000000-0000-0000-0000-00000000f402', 'player');
SELECT matches(my_notifications() -> 0 ->> 'words', 'Ben''s field is yours',
               'and Ben is told so, in words');
SELECT is(mark_seen(), 1, 'reading them clears the chip');

-- Nobody may write somebody else's notifications by hand: `tell` is the
-- functions' own, and PUBLIC has no execute on it.
RESET ROLE;
SELECT ok(NOT has_function_privilege('anon', 'tell(uuid, text, text, jsonb)',
                                     'EXECUTE'),
          'a visitor cannot forge a notification');
SELECT ok(NOT has_function_privilege('player',
                                     'assign_land(uuid, jsonb, text, int)',
                                     'EXECUTE'),
          'and a player cannot be handed the assigning function');

SELECT * FROM finish();
ROLLBACK;
