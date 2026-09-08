-- 0003_rls.sql — Invariant 6: every client write is authorised here, never by
-- client code. Direct write grants exist only for feature, instance, proposal
-- and approval; everything else is written by SECURITY DEFINER functions,
-- which run as the table owner and therefore bypass these policies.

CREATE FUNCTION is_area_owner(a uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
SELECT EXISTS (
    SELECT 1 FROM area
    WHERE area.id = a AND area.owner_id = current_user_id());
$$;

CREATE FUNCTION has_area_right(a uuid, r text) RETURNS boolean
LANGUAGE sql STABLE AS $$
SELECT EXISTS (
    SELECT 1 FROM grant_
    WHERE grant_.area_id = a
      AND grant_.grantee_id = current_user_id()
      AND grant_.right_ = r);
$$;

-- Writer = may change the world directly, without going through a proposal.
CREATE FUNCTION is_area_writer(a uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
SELECT is_area_owner(a) OR has_area_right(a, 'direct_edit');
$$;

-- Proposer = may suggest a change for approval.
CREATE FUNCTION is_area_proposer(a uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
SELECT is_area_writer(a) OR has_area_right(a, 'edit');
$$;

CREATE FUNCTION is_area_approver(a uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
SELECT is_area_owner(a) OR has_area_right(a, 'approve');
$$;

GRANT EXECUTE ON FUNCTION is_area_owner(uuid), has_area_right(uuid, text),
    is_area_writer(uuid), is_area_proposer(uuid), is_area_approver(uuid)
TO anon, player, admin;

-- ------------------------------------------------------------------ enable

ALTER TABLE artifact ENABLE ROW LEVEL SECURITY;
ALTER TABLE account ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE area ENABLE ROW LEVEL SECURITY;
ALTER TABLE grant_ ENABLE ROW LEVEL SECURITY;
ALTER TABLE feature ENABLE ROW LEVEL SECURITY;
ALTER TABLE instance ENABLE ROW LEVEL SECURITY;
ALTER TABLE proposal ENABLE ROW LEVEL SECURITY;
ALTER TABLE approval ENABLE ROW LEVEL SECURITY;
ALTER TABLE asset ENABLE ROW LEVEL SECURITY;
ALTER TABLE asset_right ENABLE ROW LEVEL SECURITY;
ALTER TABLE tile ENABLE ROW LEVEL SECURITY;
ALTER TABLE job ENABLE ROW LEVEL SECURITY;
ALTER TABLE atom ENABLE ROW LEVEL SECURITY;
ALTER TABLE worker ENABLE ROW LEVEL SECURITY;
ALTER TABLE worker_op_stats ENABLE ROW LEVEL SECURITY;
ALTER TABLE verification ENABLE ROW LEVEL SECURITY;

-- -------------------------------------------------------------------- read

-- The world, the catalog and the compile state are public.
CREATE POLICY read_all ON artifact FOR SELECT USING (true);
CREATE POLICY read_all ON area FOR SELECT USING (true);
CREATE POLICY read_all ON grant_ FOR SELECT USING (true);
CREATE POLICY read_all ON feature FOR SELECT USING (true);
CREATE POLICY read_all ON instance FOR SELECT USING (true);
CREATE POLICY read_all ON proposal FOR SELECT USING (true);
CREATE POLICY read_all ON approval FOR SELECT USING (true);
CREATE POLICY read_all ON asset FOR SELECT USING (true);
CREATE POLICY read_all ON asset_right FOR SELECT USING (true);
CREATE POLICY read_all ON tile FOR SELECT USING (true);
CREATE POLICY read_all ON job FOR SELECT USING (true);
CREATE POLICY read_all ON atom FOR SELECT USING (true);
CREATE POLICY read_all ON worker FOR SELECT USING (true);
CREATE POLICY read_all ON worker_op_stats FOR SELECT USING (true);
CREATE POLICY read_all ON verification FOR SELECT USING (true);

-- Money is private: you see your own wallet and the entries that touch it.
CREATE POLICY read_own ON account FOR SELECT
USING (owner_id = current_user_id());
CREATE POLICY read_own ON ledger FOR SELECT
USING (EXISTS (
    SELECT 1 FROM account
    WHERE account.owner_id = current_user_id()
      AND account.id IN (ledger.debit, ledger.credit)));

GRANT SELECT ON artifact, area, grant_, feature, instance, proposal, approval,
    asset, asset_right, tile, job, atom, worker, worker_op_stats, verification,
    account, ledger, balance
TO anon, player, admin;

-- ------------------------------------------------------------------- write

CREATE POLICY write_area ON feature FOR INSERT
WITH CHECK (is_area_writer(area_id));
CREATE POLICY update_area ON feature FOR UPDATE
USING (is_area_writer(area_id)) WITH CHECK (is_area_writer(area_id));
CREATE POLICY delete_area ON feature FOR DELETE
USING (is_area_writer(area_id));

CREATE POLICY write_area ON instance FOR INSERT
WITH CHECK (is_area_writer(area_id));
CREATE POLICY update_area ON instance FOR UPDATE
USING (is_area_writer(area_id)) WITH CHECK (is_area_writer(area_id));
CREATE POLICY delete_area ON instance FOR DELETE
USING (is_area_writer(area_id));

CREATE POLICY propose ON proposal FOR INSERT
WITH CHECK (author_id = current_user_id() AND is_area_proposer(area_id));

CREATE POLICY approve ON approval FOR INSERT
WITH CHECK (
    reviewer_id = current_user_id()
    AND EXISTS (
        SELECT 1 FROM proposal
        WHERE proposal.id = approval.proposal_id
          AND is_area_approver(proposal.area_id)));

GRANT INSERT, UPDATE, DELETE ON feature, instance TO player, admin;
GRANT INSERT ON proposal, approval TO player, admin;

-- No write grants for artifact, account, ledger, area, grant_, asset,
-- asset_right, tile, job, atom, worker, worker_op_stats or verification:
-- those tables move only under SECURITY DEFINER functions.
