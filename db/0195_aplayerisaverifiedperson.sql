-- 0195_aplayerisaverifiedperson.sql — a player is a verified person.
--
-- PLAN-identity.md I1–I3. The world stores the fact of verification and not
-- the identity: verified or not, how (e-ID, or manually by which admin),
-- when, and a one-way fingerprint so one person has one account (V3). A
-- manual request carries the typed name and birth date only while an admin
-- has it in front of them; deciding it drops both.
--
-- Invariant 6: "verified" is a database fact, checked here on every action it
-- unlocks (V5: getting land, building, registering products; the wallet in
-- 0196), never by the page.

CREATE TABLE player_verification (
    player_id   uuid PRIMARY KEY REFERENCES auth.user (id) ON DELETE CASCADE,
    state       text NOT NULL CHECK (state IN ('verified', 'revoked')),
    method      text NOT NULL CHECK (method IN ('eid', 'manual', 'operator')),
    by_admin    uuid REFERENCES auth.user (id) ON DELETE SET null,
    how         text NOT NULL DEFAULT '',
    -- One person, one account: the same fingerprint cannot verify two.
    fingerprint text UNIQUE,
    first_at    timestamptz NOT NULL DEFAULT now(),
    at          timestamptz NOT NULL DEFAULT now(),
    note        text NOT NULL DEFAULT ''
);

CREATE TABLE verify_request (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    player_id   uuid NOT NULL REFERENCES auth.user (id) ON DELETE CASCADE,
    -- I2: null once the request is decided.
    given_names text,
    family_name text,
    birth_date  date,
    how         text NOT NULL DEFAULT '',
    fingerprint text NOT NULL,
    state       text NOT NULL DEFAULT 'open'
                    CHECK (state IN ('open', 'confirmed', 'refused')),
    note        text NOT NULL DEFAULT '',
    decided_by  uuid REFERENCES auth.user (id) ON DELETE SET null,
    created_at  timestamptz NOT NULL DEFAULT now(),
    decided_at  timestamptz
);

CREATE UNIQUE INDEX verify_request_one_open ON verify_request (player_id)
WHERE state = 'open';

ALTER TABLE player_verification ENABLE ROW LEVEL SECURITY;
ALTER TABLE verify_request ENABLE ROW LEVEL SECURITY;

-- Invariant 6: yours, or an admin's. Only the functions below write.
CREATE POLICY mine_to_read ON player_verification FOR SELECT TO player, admin
    USING (player_id = current_user_id() OR current_user_role() = 'admin');
CREATE POLICY mine_to_read ON verify_request FOR SELECT TO player, admin
    USING (player_id = current_user_id() OR current_user_role() = 'admin');
GRANT SELECT ON verification, verify_request TO player, admin;

-- ------------------------------------------------------------ the fact

CREATE FUNCTION is_verified(who uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
SELECT coalesce((SELECT state = 'verified' FROM player_verification
                 WHERE player_id = who), false);
$$;

GRANT EXECUTE ON FUNCTION is_verified(uuid) TO anon, player, admin;

-- The sentence every action that needs it says (PLAN-identity.md §1).
CREATE FUNCTION require_verified() RETURNS void
LANGUAGE plpgsql STABLE SET search_path = public AS $$
BEGIN
    IF current_user_id() IS NOT null AND NOT is_verified(current_user_id()) THEN
        RAISE EXCEPTION 'Verify first — Profile → Verify says how'
            USING errcode = '42501';
    END IF;
END
$$;

GRANT EXECUTE ON FUNCTION require_verified() TO player, admin;

-- Keyed with a secret of the world, so it cannot be reversed by guessing names
-- and birth dates. Case, spacing and the accents a keyboard may not have do
-- not make a second person.
CREATE FUNCTION person_fingerprint(given_names text, family_name text,
                                   birth_date date) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, auth AS $$
SELECT encode(public.hmac(
    concat_ws('|',
        translate(lower(regexp_replace(btrim(given_names), '\s+', ' ', 'g')),
                  'äöüéèêëàâáçïîíôóûúÿñ', 'aoueeeeaaaciiioouuyn'),
        translate(lower(regexp_replace(btrim(family_name), '\s+', ' ', 'g')),
                  'äöüéèêëàâáçïîíôóûúÿñ', 'aoueeeeaaaciiioouuyn'),
        birth_date::text),
    coalesce(nullif(current_setting('app.fingerprint_secret', true), ''),
             auth.jwt_secret()),
    'sha256'), 'hex');
$$;

REVOKE ALL ON FUNCTION person_fingerprint(text, text, date) FROM PUBLIC;

-- The operator is the first account and has nobody to verify them.
CREATE FUNCTION verify_the_operator() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    IF NEW.role = 'admin' AND NOT EXISTS (SELECT 1 FROM auth.user WHERE id <> NEW.id) THEN
        INSERT INTO player_verification (player_id, state, method, by_admin, how)
        VALUES (NEW.id, 'verified', 'operator', NEW.id, 'the operator of this world');
    END IF;
    RETURN NEW;
END
$$;

CREATE TRIGGER verify_the_operator AFTER INSERT ON auth.user
FOR EACH ROW EXECUTE FUNCTION verify_the_operator();

-- A world that had players before this: its admins made it, and are verified
-- as its operators. Its players are not, and are asked like anyone else.
INSERT INTO player_verification (player_id, state, method, by_admin, how)
SELECT u.id, 'verified', 'operator', u.id AS by_admin, 'an admin before verification existed'
FROM auth.user AS u WHERE u.role = 'admin';

-- ------------------------------------------------------------ what you are

CREATE FUNCTION my_verification() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
SELECT CASE
    WHEN v.state IS NOT null THEN jsonb_build_object(
        'state', v.state, 'method', v.method, 'at', v.at, 'note', v.note,
        'how', v.how, 'by', player_name(v.by_admin))
    WHEN r.state = 'open' THEN jsonb_build_object('state', 'waiting', 'at', r.created_at)
    WHEN r.state = 'refused' THEN jsonb_build_object(
        'state', 'refused', 'note', r.note, 'at', r.decided_at)
    ELSE jsonb_build_object('state', 'none') END
FROM (SELECT current_user_id() AS uid) me
LEFT JOIN player_verification v ON v.player_id = me.uid
LEFT JOIN LATERAL (SELECT * FROM verify_request q WHERE q.player_id = me.uid
                   ORDER BY q.created_at DESC LIMIT 1) r ON true;
$$;

GRANT EXECUTE ON FUNCTION my_verification() TO player, admin;

-- Without e-ID: what an admin needs to check you, and how they can.
CREATE FUNCTION request_verification(given_names text, family_name text,
                                     birth_date date, how text DEFAULT '')
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE
    uid uuid := current_user_id();
    fp  text;
    rid uuid;
BEGIN
    IF uid IS NULL THEN
        RAISE EXCEPTION 'sign in before you verify' USING errcode = '28000';
    END IF;
    IF is_verified(uid) THEN
        RAISE EXCEPTION 'you are verified already' USING errcode = '23505';
    END IF;
    IF btrim(coalesce(given_names, '')) = '' OR btrim(coalesce(family_name, '')) = ''
       OR birth_date IS null THEN
        RAISE EXCEPTION 'an admin needs your given names, family name and birth date'
            USING errcode = '23514';
    END IF;
    IF birth_date > current_date - interval '18 years' THEN
        RAISE EXCEPTION 'players are 18 or older' USING errcode = '23514';
    END IF;
    fp := person_fingerprint(given_names, family_name, birth_date);
    IF EXISTS (SELECT 1 FROM player_verification WHERE fingerprint = fp AND player_id <> uid) THEN
        RAISE EXCEPTION 'an account for this person already exists' USING errcode = '23505';
    END IF;
    UPDATE verify_request SET given_names = btrim(request_verification.given_names),
        family_name = btrim(request_verification.family_name),
        birth_date = request_verification.birth_date, how = btrim(coalesce(request_verification.how, '')),
        fingerprint = fp
    WHERE player_id = uid AND state = 'open' RETURNING id INTO rid;
    IF rid IS null THEN
        INSERT INTO verify_request (player_id, given_names, family_name, birth_date, how, fingerprint)
        VALUES (uid, btrim(given_names), btrim(family_name), birth_date,
                btrim(coalesce(how, '')), fp)
        RETURNING id INTO rid;
    END IF;
    PERFORM tell(u.id, 'verify_requested',
                 player_name(uid) || ' asks to be verified without e-ID',
                 jsonb_build_object('panel', 'Players', 'request', rid))
    FROM auth.user u WHERE u.role = 'admin';
    RETURN jsonb_build_object('id', rid, 'state', 'waiting');
END
$$;

GRANT EXECUTE ON FUNCTION request_verification(text, text, date, text) TO player, admin;

-- ------------------------------------------------------------ the admin

-- What is waiting, with the name and birth date as typed, and every player
-- with what is known of them — the list a revocation is made from.
CREATE FUNCTION verification_requests() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, auth AS $$
BEGIN
    PERFORM require_admin();
    RETURN (SELECT coalesce(jsonb_agg(jsonb_build_object(
            'id', r.id, 'player_id', r.player_id, 'who', player_name(r.player_id),
            'given_names', r.given_names, 'family_name', r.family_name,
            'birth_date', r.birth_date, 'how', r.how, 'at', r.created_at)
            ORDER BY r.created_at), '[]'::jsonb)
        FROM verify_request r WHERE r.state = 'open');
END
$$;

CREATE FUNCTION players() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, auth AS $$
BEGIN
    PERFORM require_admin();
    RETURN (SELECT coalesce(jsonb_agg(jsonb_build_object(
            'id', u.id, 'who', player_name(u.id), 'role', u.role,
            'state', coalesce(v.state, 'none'), 'method', v.method,
            'by', player_name(v.by_admin), 'how', v.how, 'at', v.at, 'note', v.note)
            ORDER BY player_name(u.id)), '[]'::jsonb)
        FROM auth.user u LEFT JOIN player_verification v ON v.player_id = u.id);
END
$$;

CREATE FUNCTION decide_verification(request_id uuid, confirm boolean, words text)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE
    req verify_request;
    me  uuid := current_user_id();
BEGIN
    PERFORM require_admin();
    SELECT * INTO req FROM verify_request WHERE id = request_id FOR UPDATE;
    IF req.id IS null THEN
        RAISE EXCEPTION 'there is no such request' USING errcode = '23503';
    END IF;
    IF req.state <> 'open' THEN
        RAISE EXCEPTION 'that request was already %', req.state USING errcode = '23514';
    END IF;
    IF confirm AND EXISTS (SELECT 1 FROM player_verification
                           WHERE fingerprint = req.fingerprint AND player_id <> req.player_id) THEN
        confirm := false;
        words := 'an account for this person already exists';
    END IF;
    IF NOT confirm AND btrim(coalesce(words, '')) = '' THEN
        RAISE EXCEPTION 'say why — the player reads it' USING errcode = '23514';
    END IF;
    -- I2: decided, so the name and birth date go; the fingerprint stays.
    UPDATE verify_request SET state = CASE WHEN confirm THEN 'confirmed' ELSE 'refused' END,
        note = btrim(coalesce(words, '')), decided_by = me, decided_at = now(),
        given_names = null, family_name = null, birth_date = null
    WHERE id = request_id;
    IF confirm THEN
        INSERT INTO player_verification (player_id, state, method, by_admin, how, fingerprint)
        VALUES (req.player_id, 'verified', 'manual', me, btrim(coalesce(words, '')),
                req.fingerprint)
        ON CONFLICT (player_id) DO UPDATE SET state = 'verified', method = 'manual',
            by_admin = me, how = excluded.how, fingerprint = excluded.fingerprint,
            at = now(), note = '';
        PERFORM tell(req.player_id, 'verified',
                     'You are verified — ' || player_name(me) || ' checked it',
                     jsonb_build_object('panel', 'Verify'));
    ELSE
        PERFORM tell(req.player_id, 'verify_refused',
                     'Your verification was refused: ' || btrim(words),
                     jsonb_build_object('panel', 'Verify'));
    END IF;
    RETURN jsonb_build_object('state', CASE WHEN confirm THEN 'verified' ELSE 'refused' END,
                              'who', player_name(req.player_id), 'note', words);
END
$$;

CREATE FUNCTION revoke_verification(player uuid, note text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, auth AS $$
BEGIN
    PERFORM require_admin();
    IF btrim(coalesce(note, '')) = '' THEN
        RAISE EXCEPTION 'say why — the player reads it' USING errcode = '23514';
    END IF;
    UPDATE player_verification SET state = 'revoked', note = btrim(revoke_verification.note),
        at = now(), by_admin = current_user_id()
    WHERE player_id = player AND state = 'verified';
    IF NOT FOUND THEN
        RAISE EXCEPTION '% is not verified', player_name(player) USING errcode = '23514';
    END IF;
    PERFORM tell(player, 'verify_revoked',
                 'Your verification was revoked: ' || btrim(note),
                 jsonb_build_object('panel', 'Verify'));
    RETURN jsonb_build_object('state', 'revoked', 'who', player_name(player));
END
$$;

REVOKE ALL ON FUNCTION verification_requests(), players(),
    decide_verification(uuid, boolean, text), revoke_verification(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION verification_requests(), players(),
    decide_verification(uuid, boolean, text), revoke_verification(uuid, text) TO admin;

-- ------------------------------------------------------------ what it unlocks

-- V5: an unverified player walks, visits and renders. Land, building and
-- products want a verified one. RLS keeps the authority (is_area_writer); the
-- triggers are there so what refuses says the sentence.
CREATE OR REPLACE FUNCTION is_area_writer(a uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
SELECT (is_area_owner(a) OR has_area_right(a, 'direct_edit'))
       AND (current_user_id() IS null OR is_verified(current_user_id()));
$$;

CREATE FUNCTION verified_first() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
    PERFORM require_verified();
    RETURN coalesce(NEW, OLD);
END
$$;

CREATE TRIGGER verified_first BEFORE INSERT OR UPDATE ON land_request
FOR EACH ROW EXECUTE FUNCTION verified_first();
CREATE TRIGGER verified_first BEFORE INSERT ON asset
FOR EACH ROW EXECUTE FUNCTION verified_first();
CREATE TRIGGER verified_first BEFORE INSERT OR UPDATE ON instance
FOR EACH ROW EXECUTE FUNCTION verified_first();
CREATE TRIGGER verified_first BEFORE INSERT OR UPDATE ON feature
FOR EACH ROW EXECUTE FUNCTION verified_first();

-- ------------------------------------------------------------ api

CREATE FUNCTION api.my_verification() RETURNS jsonb
LANGUAGE sql STABLE AS $$SELECT public.my_verification()$$;
CREATE FUNCTION api.request_verification(given_names text, family_name text,
                                         birth_date date, how text DEFAULT '')
RETURNS jsonb LANGUAGE sql VOLATILE
AS $$SELECT public.request_verification(given_names, family_name, birth_date, how)$$;
CREATE FUNCTION api.verification_requests() RETURNS jsonb
LANGUAGE sql STABLE AS $$SELECT public.verification_requests()$$;
CREATE FUNCTION api.players() RETURNS jsonb
LANGUAGE sql STABLE AS $$SELECT public.players()$$;
CREATE FUNCTION api.decide_verification(request_id uuid, confirm boolean, words text)
RETURNS jsonb LANGUAGE sql VOLATILE
AS $$SELECT public.decide_verification(request_id, confirm, words)$$;
CREATE FUNCTION api.revoke_verification(player uuid, note text) RETURNS jsonb
LANGUAGE sql VOLATILE AS $$SELECT public.revoke_verification(player, note)$$;

GRANT EXECUTE ON FUNCTION api.my_verification(),
    api.request_verification(text, text, date, text) TO player, admin;
GRANT EXECUTE ON FUNCTION api.verification_requests(), api.players(),
    api.decide_verification(uuid, boolean, text),
    api.revoke_verification(uuid, text) TO admin;
