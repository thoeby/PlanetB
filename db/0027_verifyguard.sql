-- 0027_verifyguard.sql — the WP3 review. A perceptual verdict may only enter
-- through a verify atom the caller holds, or through a spot check the server
-- itself said was due; it counts once per verifier; and the internal functions
-- WP3 added are no longer executable by clients.

-- ------------------------------------------------------------ the guard
--
-- Invariant 6/8: `submit_verification` trusted its caller to be one of the
-- three independent verifiers, but the rule that makes them independent lives
-- in claim_atom, and the RPC could be called without ever claiming. The API
-- wrapper now checks the claim (or, for a spot check, re-asks spot_due), and
-- the public function is reachable only from inside submit_atom and here.

CREATE OR REPLACE FUNCTION api.submit_verification(atom_id bigint, passed boolean,
                                                   metrics jsonb DEFAULT '{}'::jsonb,
                                                   spot boolean DEFAULT false)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    a   atom%rowtype;
    j   job%rowtype;
    wid uuid;
BEGIN
    SELECT * INTO a FROM atom WHERE id = submit_verification.atom_id;
    IF a.id IS NULL THEN
        RAISE EXCEPTION 'no atom %', submit_verification.atom_id;
    END IF;
    SELECT * INTO j FROM job WHERE id = a.job_id;
    SELECT w.id INTO wid FROM worker w WHERE w.user_id = current_user_id();
    IF spot THEN
        IF NOT EXISTS (SELECT 1 FROM spot_due(j.z, j.x, j.y) d
                       WHERE d.kind = 'perceptual' AND d.atom_id = a.id) THEN
            RAISE EXCEPTION 'no spot check of %/%/% is due from you', j.z, j.x, j.y
                USING errcode = '42501';
        END IF;
    ELSIF NOT EXISTS (SELECT 1 FROM atom v
                      WHERE v.job_id = a.job_id AND v.op = 'verify'
                        AND v.worker_id = wid AND v.state IN ('claimed', 'verified')) THEN
        RAISE EXCEPTION 'you hold no check of sog %', a.id USING errcode = '42501';
    END IF;
    RETURN public.submit_verification(submit_verification.atom_id, passed,
                                      metrics, spot);
END
$$;

REVOKE EXECUTE ON FUNCTION public.submit_verification(bigint, boolean, jsonb, boolean)
FROM PUBLIC, player, admin;

-- ------------------------------------------------------ one verdict each
--
-- db/0019_trust.sql's, with two changes: a verifier's second call about the
-- same output replaces their row and moves nothing else (the trainer's trust
-- and the counts were credited on the first), and a sog with no trainer — a
-- baseline tile handed a perceptual opinion — is not an error.

CREATE OR REPLACE FUNCTION submit_verification(p_atom bigint, p_passed boolean,
                                               p_metrics jsonb DEFAULT '{}'::jsonb,
                                               p_spot boolean DEFAULT false)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    a       atom%rowtype;
    wid     uuid := my_worker(NULL);
    trainer uuid;
    again   boolean;
BEGIN
    SELECT * INTO a FROM atom WHERE id = p_atom FOR UPDATE;
    IF a.id IS NULL OR a.op <> 'sog' THEN
        RAISE EXCEPTION 'atom % is not a sog to verify', p_atom;
    END IF;
    IF a.state NOT IN ('submitted', 'verified') THEN
        RAISE EXCEPTION 'sog % is %, and has no answer to check', p_atom, a.state;
    END IF;
    SELECT dep.worker_id INTO trainer FROM atom dep
    WHERE dep.id = ANY (a.deps) AND dep.op = 'train';
    IF wid IN (a.worker_id, trainer) THEN
        RAISE EXCEPTION 'you produced sog % and may not verify it', p_atom;
    END IF;

    again := EXISTS (SELECT 1 FROM verification v
                     WHERE v.atom_id = a.id AND v.verifier_worker_id = wid
                       AND v.kind = 'perceptual'
                       AND v.metrics ->> 'output' = a.output_sha256);
    INSERT INTO verification (atom_id, verifier_worker_id, kind, passed, metrics)
    VALUES (a.id, wid, 'perceptual', p_passed,
            coalesce(p_metrics, '{}'::jsonb)
            || jsonb_build_object('spot', p_spot, 'output', a.output_sha256))
    ON CONFLICT (atom_id, verifier_worker_id) WHERE kind = 'perceptual'
        AND verifier_worker_id IS NOT NULL
    DO UPDATE SET passed = excluded.passed, metrics = excluded.metrics, at = now();
    IF again THEN
        RETURN a.state;
    END IF;
    PERFORM record_ok(wid, 'verify');

    IF NOT p_passed THEN
        RETURN rejected(a, trainer);
    END IF;
    IF trainer IS NOT NULL THEN
        PERFORM credit(trainer, trust_gain());
        PERFORM record_ok(trainer, 'train');
    END IF;
    IF a.state = 'submitted' AND verify_passes(a) >= verify_required(a) THEN
        UPDATE atom SET state = 'verified' WHERE id = a.id;
        SELECT * INTO a FROM atom WHERE id = a.id;
        PERFORM advance_atoms(a.job_id);
        PERFORM publish_sog(a, (SELECT user_id FROM worker WHERE id = a.worker_id),
                            a.result -> 'manifest');
        RETURN 'verified';
    END IF;
    RETURN a.state;
END
$$;

-- ------------------------------------------------------------------- grants
--
-- The sweep in db/0026_review.sql stopped at WP2's functions; these are WP3's.

REVOKE ALL ON FUNCTION publish_sog(atom, uuid, jsonb), retrain(atom),
    rejected(atom, uuid), may_verify(bigint, bigint, uuid), verify_passes(atom),
    verify_required(atom), spot_sog(int, int, int), verify_count(bigint),
    credit(uuid, numeric), record_ok(uuid, text), trust_min(text), trust_gain(),
    trust_loss(), trust_work(), explain_text(text)
FROM PUBLIC;
