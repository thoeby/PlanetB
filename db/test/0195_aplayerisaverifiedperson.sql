-- A player is a verified person (db/0195_aplayerisaverifiedperson.sql).
BEGIN;
SELECT plan(22);

DELETE FROM auth.user;
SELECT register('anna195@example.com', 'password12') AS anna,
       register('ben195@example.com', 'password12') AS ben,
       register('cara195@example.com', 'password12') AS cara,
       register('dora195@example.com', 'password12') AS dora \gset
UPDATE auth.user SET name = initcap(split_part(email, '195', 1));

CREATE FUNCTION acting_as(uid uuid) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE r text := (SELECT role FROM auth.user WHERE id = uid);
BEGIN
    EXECUTE format('SET LOCAL request.jwt.claims = %L',
        json_build_object('sub', uid, 'role', r)::text);
    EXECUTE format('SET LOCAL ROLE %I', r);
END
$$;
GRANT EXECUTE ON FUNCTION acting_as(uuid) TO player, admin;

-- The operator and everybody else ----------------------------------------
SELECT is((SELECT method FROM player_verification WHERE player_id = :'anna'), 'operator',
          'the first account is the operator, verified by being it');
SELECT acting_as(:'ben');
SELECT is(my_verification() ->> 'state', 'none', 'Ben is not verified');
SELECT throws_ok($$SELECT request_land('a field')$$, '42501',
                 'Verify first — Profile → Verify says how',
                 'and asking for land says: verify first');
SELECT throws_ok($$SELECT request_verification('Ben', 'Muster', current_date - 3000, '')$$,
                 '23514', 'players are 18 or older', 'a child is refused');

-- Without e-ID ------------------------------------------------------------
SELECT is(request_verification('Ben', 'Müller', '1990-04-01', 'in person on Friday') ->> 'state',
          'waiting', 'Ben asks to be verified without e-ID');
SELECT is(my_verification() ->> 'state', 'waiting', 'and is told he is waiting for an admin');
SELECT throws_ok($$SELECT verification_requests()$$, '42501', null,
                 'a player cannot read the requests');

RESET ROLE;
SELECT acting_as(:'anna');
SELECT is(verification_requests() -> 0 ->> 'family_name', 'Müller',
          'the admin sees the name as typed');
SELECT is(verification_requests() -> 0 ->> 'how', 'in person on Friday', 'and how to check it');
SELECT is(decide_verification((verification_requests() -> 0 ->> 'id')::uuid, true,
                              'checked in person') ->> 'state',
          'verified', 'the admin confirms it');
RESET ROLE;
SELECT is((SELECT row(given_names, family_name, birth_date)::text FROM verify_request
           WHERE player_id = :'ben'), '(,,)', 'and the name and birth date are gone');
SELECT is((SELECT method || ' by ' || player_name(by_admin) FROM player_verification
           WHERE player_id = :'ben'), 'manual by Anna', 'what stays is how, and who');

SELECT acting_as(:'ben');
SELECT is(my_verification() ->> 'state', 'verified', 'Ben is verified');
SELECT lives_ok($$SELECT request_land('a field')$$, 'and may ask for land now');

-- One person, one account ---------------------------------------------------
RESET ROLE;
SELECT acting_as(:'cara');
SELECT throws_ok($$SELECT request_verification('ben', 'MULLER', '1990-04-01', '')$$,
                 '23505', 'an account for this person already exists',
                 'Ben again, spelt differently, from another account, is refused');

-- Refused, with a note ----------------------------------------------------
SELECT lives_ok($$SELECT request_verification('Cara', 'Rossi', '1985-02-02', 'video call')$$,
                'Cara asks');
RESET ROLE;
SELECT acting_as(:'anna');
SELECT throws_ok(format($$SELECT decide_verification(%L, false, '')$$,
                        verification_requests() -> 0 ->> 'id'),
                 '23514', 'say why — the player reads it', 'a refusal says why');
SELECT lives_ok(format($$SELECT decide_verification(%L, false, 'the call never happened')$$,
                       verification_requests() -> 0 ->> 'id'), 'the admin refuses it');
RESET ROLE;
SELECT acting_as(:'cara');
SELECT is(my_verification() ->> 'note', 'the call never happened', 'Cara reads why');

-- Revoked -------------------------------------------------------------------
RESET ROLE;
SELECT acting_as(:'anna');
SELECT is(revoke_verification(:'ben', 'the check was wrong') ->> 'state', 'revoked',
          'the admin revokes Ben');
RESET ROLE;
SELECT acting_as(:'ben');
SELECT is(my_verification() ->> 'note', 'the check was wrong', 'Ben reads why');
SELECT throws_ok($$SELECT request_land('another field')$$, '42501',
                 'Verify first — Profile → Verify says how',
                 'and what needed it says verify first again');

SELECT * FROM finish();
ROLLBACK;
