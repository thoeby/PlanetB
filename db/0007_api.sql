-- 0007_api.sql — the api schema PostgREST exposes. Every view is
-- security_invoker, so the policies in 0003_rls.sql still decide who sees and
-- writes what: the API surface adds no authority of its own (Invariant 6).

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticator') THEN
        CREATE ROLE authenticator LOGIN NOINHERIT;
    END IF;
END
$$;
ALTER ROLE authenticator PASSWORD :'authpw';
GRANT anon, player, admin TO authenticator;

CREATE SCHEMA api;
GRANT USAGE ON SCHEMA api TO anon, player, admin;

-- ------------------------------------------------------------------- reads

CREATE VIEW api.tile WITH (security_invoker = true) AS SELECT * FROM public.tile;
CREATE VIEW api.area WITH (security_invoker = true) AS SELECT * FROM public.area;
CREATE VIEW api.grant_ WITH (security_invoker = true) AS SELECT * FROM public.grant_;
CREATE VIEW api.asset WITH (security_invoker = true) AS SELECT * FROM public.asset;
CREATE VIEW api.asset_right WITH (security_invoker = true) AS SELECT * FROM public.asset_right;
CREATE VIEW api.artifact WITH (security_invoker = true) AS SELECT * FROM public.artifact;
CREATE VIEW api.job WITH (security_invoker = true) AS SELECT * FROM public.job;
CREATE VIEW api.atom WITH (security_invoker = true) AS SELECT * FROM public.atom;
CREATE VIEW api.worker WITH (security_invoker = true) AS SELECT * FROM public.worker;
CREATE VIEW api.verification WITH (security_invoker = true) AS SELECT * FROM public.verification;
CREATE VIEW api.structural_rule WITH (security_invoker = true) AS SELECT * FROM public.structural_rule;
CREATE VIEW api.balance WITH (security_invoker = true) AS SELECT * FROM public.balance;
CREATE VIEW api.account WITH (security_invoker = true) AS SELECT * FROM public.account;

-- ----------------------------------------------------------- reads + writes

CREATE VIEW api.feature WITH (security_invoker = true) AS SELECT * FROM public.feature;
CREATE VIEW api.instance WITH (security_invoker = true) AS SELECT * FROM public.instance;
CREATE VIEW api.proposal WITH (security_invoker = true) AS SELECT * FROM public.proposal;
CREATE VIEW api.approval WITH (security_invoker = true) AS SELECT * FROM public.approval;

GRANT SELECT ON ALL TABLES IN SCHEMA api TO anon, player, admin;
GRANT INSERT, UPDATE, DELETE ON api.feature, api.instance TO player, admin;
GRANT INSERT ON api.proposal, api.approval TO player, admin;

-- --------------------------------------------------------------------- rpc

CREATE FUNCTION api.register(email text, pw text) RETURNS uuid
LANGUAGE sql AS $$SELECT public.register(email, pw)$$;

CREATE FUNCTION api.login(email text, pw text) RETURNS text
LANGUAGE sql AS $$SELECT public.login(email, pw)$$;

CREATE FUNCTION api.ensure_job(z int, x int, y int, bounty numeric DEFAULT 0)
RETURNS bigint LANGUAGE sql AS $$SELECT public.ensure_job(z, x, y, bounty)$$;

CREATE FUNCTION api.claim_atom(caps jsonb DEFAULT '{}'::jsonb) RETURNS public.atom
LANGUAGE sql AS $$SELECT public.claim_atom(caps)$$;

CREATE FUNCTION api.heartbeat(atom_id bigint) RETURNS void
LANGUAGE sql AS $$SELECT public.heartbeat(atom_id)$$;

CREATE FUNCTION api.submit_atom(atom_id bigint, output_sha256 text, result jsonb)
RETURNS text LANGUAGE sql AS $$SELECT public.submit_atom(atom_id, output_sha256, result)$$;

CREATE FUNCTION api.publish_tile(z int, x int, y int, target_version bigint,
                                 sog_sha256 text, manifest jsonb)
RETURNS boolean LANGUAGE sql
AS $$SELECT public.publish_tile(z, x, y, target_version, sog_sha256, manifest)$$;

CREATE FUNCTION api.set_bounty(job_id bigint, amount numeric) RETURNS void
LANGUAGE sql AS $$SELECT public.set_bounty(job_id, amount)$$;

CREATE FUNCTION api.pay(to_account uuid, amount numeric, ref text) RETURNS void
LANGUAGE sql AS $$SELECT public.pay(to_account, amount, ref)$$;

CREATE FUNCTION api.register_artifact(sha256 text, kind text, bytes bigint,
                                      algo_version text) RETURNS text
LANGUAGE sql AS $$SELECT public.register_artifact(sha256, kind, bytes, algo_version)$$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA api FROM PUBLIC;
GRANT EXECUTE ON FUNCTION api.register(text, text), api.login(text, text) TO anon, player, admin;
GRANT EXECUTE ON FUNCTION api.ensure_job(int, int, int, numeric),
    api.claim_atom(jsonb), api.heartbeat(bigint),
    api.submit_atom(bigint, text, jsonb),
    api.publish_tile(int, int, int, bigint, text, jsonb),
    api.set_bounty(bigint, numeric), api.pay(uuid, numeric, text),
    api.register_artifact(text, text, bigint, text)
TO player, admin;
