-- 0129_abountypaysoutexactly.sql — a bounty pays out to the last cent and no
-- further.
--
-- db/0006's release_escrow splits the pot by the seconds each worker spent and
-- rounds every share to six places. Rounding up is as likely as rounding down,
-- so a job with several workers can pay out a shade more than it held; the
-- difference comes out of escrow, which is every other open job's bounty. It
-- is dust — under a hundredth of a cent a job — but escrow is money held for
-- somebody else (Invariant 5), and "nearly" is not a balance.
--
-- The last share is now what is left rather than its own rounding, so the pot
-- is paid out exactly. The dust sweep below it stays for the case where the
-- shares round down and nobody is owed the remainder.
CREATE OR REPLACE FUNCTION release_escrow(p_job bigint) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
    pot   numeric;
    total numeric;
    n     int;
    w     record;
    paid  numeric := 0;
    seen  int := 0;
    share numeric;
BEGIN
    SELECT bounty INTO pot FROM job WHERE id = p_job;
    IF coalesce(pot, 0) <= 0 THEN
        RETURN;
    END IF;

    SELECT sum(s.secs), count(*) INTO total, n FROM (
        SELECT sum(coalesce((a.result ->> 'gpu_seconds')::numeric, 0)) AS secs
        FROM atom a
        WHERE a.job_id = p_job AND a.worker_id IS NOT NULL
          AND a.state IN ('verified', 'submitted')
        GROUP BY a.worker_id) AS s;
    IF n IS NULL OR n = 0 THEN
        RETURN;
    END IF;

    FOR w IN SELECT a.worker_id,
                    sum(coalesce((a.result ->> 'gpu_seconds')::numeric, 0)) AS secs
             FROM atom a
             WHERE a.job_id = p_job AND a.worker_id IS NOT NULL
               AND a.state IN ('verified', 'submitted')
             GROUP BY a.worker_id ORDER BY a.worker_id LOOP
        seen := seen + 1;
        share := CASE WHEN total > 0 THEN round(pot * w.secs / total, 6)
                      ELSE round(pot / n, 6) END;
        -- The last one is handed the remainder, so the shares add up to the
        -- pot however they rounded on the way.
        IF seen = n THEN
            share := pot - paid;
        END IF;
        share := least(share, pot - paid);
        paid := paid + share;
        IF share > 0 THEN
            PERFORM transfer(escrow_account(),
                (SELECT ac.id FROM account ac
                 INNER JOIN worker wk ON wk.user_id = ac.owner_id
                 WHERE wk.id = w.worker_id),
                share, 'pay:' || p_job || ':' || w.worker_id);
        END IF;
    END LOOP;

    IF pot - paid > 0 THEN
        PERFORM transfer(escrow_account(), treasury_account(), pot - paid,
                         'dust:' || p_job);
    END IF;
    UPDATE job SET bounty = 0 WHERE id = p_job;
END
$$;
