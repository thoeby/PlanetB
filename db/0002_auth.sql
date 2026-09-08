-- 0002_auth.sql — users, password hashing, HS256 JWTs, role helpers.
-- The token is minted here so that no server process outside Postgres ever
-- sees a password; PostgREST only verifies the signature.

CREATE SCHEMA auth;

CREATE TABLE auth.user (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email      text NOT NULL UNIQUE CHECK (email ~ '^[^@[:space:]]+@[^@[:space:]]+$'),
    pw_hash    text NOT NULL,
    role       text NOT NULL DEFAULT 'player' CHECK (role IN ('player', 'admin')),
    created_at timestamptz NOT NULL DEFAULT now()
);

-- Deferred from 0001: those columns are auth users; the table only exists now.
ALTER TABLE account ADD FOREIGN KEY (owner_id) REFERENCES auth.user (id);
ALTER TABLE area ADD FOREIGN KEY (owner_id) REFERENCES auth.user (id);
ALTER TABLE grant_ ADD FOREIGN KEY (grantee_id) REFERENCES auth.user (id);
ALTER TABLE proposal ADD FOREIGN KEY (author_id) REFERENCES auth.user (id);
ALTER TABLE approval ADD FOREIGN KEY (reviewer_id) REFERENCES auth.user (id);
ALTER TABLE asset ADD FOREIGN KEY (creator_id) REFERENCES auth.user (id);
ALTER TABLE asset_right ADD FOREIGN KEY (holder_id) REFERENCES auth.user (id);
ALTER TABLE artifact ADD FOREIGN KEY (created_by) REFERENCES auth.user (id);
ALTER TABLE tile ADD FOREIGN KEY (published_by) REFERENCES auth.user (id);
ALTER TABLE worker ADD FOREIGN KEY (user_id) REFERENCES auth.user (id);

-- ------------------------------------------------------------------ base64url

CREATE FUNCTION auth.b64url_encode(data bytea) RETURNS text
LANGUAGE sql IMMUTABLE STRICT AS $$
SELECT translate(encode(data, 'base64'), E'+/=\n', '-_');
$$;

CREATE FUNCTION auth.b64url_decode(data text) RETURNS bytea
LANGUAGE sql IMMUTABLE STRICT AS $$
SELECT decode(
    translate(data, '-_', '+/') || repeat('=', (4 - length(data) % 4) % 4),
    'base64');
$$;

-- ----------------------------------------------------------------------- jwt

CREATE FUNCTION auth.jwt_secret() RETURNS text
LANGUAGE plpgsql STABLE AS $$
DECLARE
    s text := current_setting('app.jwt_secret', true);
BEGIN
    IF s IS NULL OR length(s) < 32 THEN
        RAISE EXCEPTION 'app.jwt_secret is unset or shorter than 32 chars';
    END IF;
    RETURN s;
END
$$;

CREATE FUNCTION auth.sign(payload json) RETURNS text
LANGUAGE sql VOLATILE AS $$
WITH signing AS (
    SELECT
        auth.b64url_encode(convert_to('{"alg":"HS256","typ":"JWT"}', 'utf8'))
        || '.' || auth.b64url_encode(convert_to(payload::text, 'utf8')) AS body
)
SELECT
    signing.body || '.'
    || auth.b64url_encode(
        public.hmac(signing.body, auth.jwt_secret(), 'sha256'))
FROM signing;
$$;

-- Verifies the HS256 signature and returns the payload. Used by tests and by
-- tooling; PostgREST does its own verification in front of the API.
CREATE FUNCTION auth.verify(token text) RETURNS json
LANGUAGE plpgsql STABLE AS $$
DECLARE
    parts text [] := string_to_array(token, '.');
    body  text;
BEGIN
    IF array_length(parts, 1) <> 3 THEN
        RAISE EXCEPTION 'malformed token';
    END IF;
    body := parts[1] || '.' || parts[2];
    IF auth.b64url_encode(public.hmac(body, auth.jwt_secret(), 'sha256'))
        <> parts[3] THEN
        RAISE EXCEPTION 'bad signature';
    END IF;
    RETURN convert_from(auth.b64url_decode(parts[2]), 'utf8')::json;
END
$$;

-- -------------------------------------------------------------------- public

-- Reads the caller identity PostgREST put into request.jwt.claims. Every
-- authorisation decision in this database starts here (Invariant 6).
CREATE FUNCTION current_user_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
SELECT nullif(
    current_setting('request.jwt.claims', true)::json ->> 'sub', '')::uuid;
$$;

CREATE FUNCTION current_user_role() RETURNS text
LANGUAGE sql STABLE AS $$
SELECT coalesce(
    current_setting('request.jwt.claims', true)::json ->> 'role', 'anon');
$$;

CREATE FUNCTION register(email text, pw text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE
    uid uuid;
BEGIN
    IF length(pw) < 8 THEN
        RAISE EXCEPTION 'password must be at least 8 characters';
    END IF;
    INSERT INTO auth.user (email, pw_hash)
    VALUES (lower(register.email), public.crypt(register.pw, public.gen_salt('bf')))
    RETURNING id INTO uid;
    -- one wallet per user; system accounts have owner_id null
    INSERT INTO account (owner_id) VALUES (uid);
    RETURN uid;
END
$$;

CREATE FUNCTION login(email text, pw text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE
    u auth.user%rowtype;
BEGIN
    SELECT * INTO u FROM auth.user WHERE auth.user.email = lower(login.email);
    IF u.id IS NULL OR u.pw_hash <> public.crypt(login.pw, u.pw_hash) THEN
        RAISE EXCEPTION 'invalid credentials' USING errcode = '28P01';
    END IF;
    RETURN auth.sign(json_build_object(
        'sub', u.id,
        'role', u.role,
        'email', u.email,
        'exp', extract(epoch FROM now() + interval '12 hours')::bigint));
END
$$;

-- ------------------------------------------------------------------- grants

GRANT USAGE ON SCHEMA public TO anon, player, admin;
GRANT player TO admin;

REVOKE ALL ON FUNCTION register(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION login(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION register(text, text) TO anon, player, admin;
GRANT EXECUTE ON FUNCTION login(text, text) TO anon, player, admin;
GRANT EXECUTE ON FUNCTION current_user_id() TO anon, player, admin;
GRANT EXECUTE ON FUNCTION current_user_role() TO anon, player, admin;

-- auth.user is never reachable through the API; only the definer functions above.
REVOKE ALL ON SCHEMA auth FROM PUBLIC;
