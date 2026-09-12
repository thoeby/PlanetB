-- What to call a player (db/0061_playername.sql).
BEGIN;
SELECT plan(8);

INSERT INTO auth.user (id, email, pw_hash, role) VALUES
('00000000-0000-0000-0000-00000000f201', 'anna@example.com', 'x', 'admin'),
('00000000-0000-0000-0000-00000000f202', 'ben@example.com', 'x', 'player');

SELECT has_column('auth', 'user', 'name', 'a player has a name');

-- Nobody has said one yet: the world falls back to what the page showed
-- before, never to the email.
SELECT is(player_name('00000000-0000-0000-0000-00000000f201'), '00000000',
          'no name yet reads as the short id');

SET LOCAL ROLE player;
SET LOCAL request.jwt.claims
    = '{"sub": "00000000-0000-0000-0000-00000000f202", "role": "player"}';

SELECT is(me() ->> 'email', 'ben@example.com', 'me() is whoever holds the token');
SELECT is(me() ->> 'name', null, 'and has no name until he says one');

SELECT is(set_my_name('Ben') ->> 'name', 'Ben', 'a player names himself');
SELECT is(player_name('00000000-0000-0000-0000-00000000f202'), 'Ben',
          'and the world calls him that');

-- The name is the only thing set_my_name touches, and only on the caller's
-- own row: the row comes from the token, never from an argument (Invariant 6).
-- auth.user is nobody's to read, so this asks as the owner of the schema.
RESET ROLE;
SELECT is((SELECT name FROM auth.user
           WHERE id = '00000000-0000-0000-0000-00000000f201'), null,
          'naming yourself does not name anybody else');

SET LOCAL ROLE player;
SELECT throws_ok($$SELECT set_my_name('   ')$$, '23514',
                 'a name is what the world calls you — type one',
                 'a blank is not a name');

SELECT * FROM finish();
ROLLBACK;
