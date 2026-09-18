-- 0150_dropmeansgone.sql — dropping a job takes its pieces with it.
--
-- db/0105's drop_job cancelled the job and marked its atoms `failed`, and the
-- atoms stayed. new_atom finds an unfinished or failed atom by its hash and
-- hands it to whichever job asks next (db/0100), so compiling the tile again
-- adopted the very pieces that had just been dropped, with their outputs: the
-- tile came back identical and the drop had done nothing a person could see.
-- That is right for a piece that *failed* — three attempts and a reason to
-- look at, kept — and wrong for one somebody deliberately threw away.
--
-- So a drop deletes the job, and `atom_job_id_fkey` is ON DELETE CASCADE, so
-- its atoms go with it and their verifications with them. What does not go is
-- anything in the store: an artifact is written once and never unmade
-- (Invariant 1). The next compile makes fresh atoms, computes them again, and
-- if the bytes come out identical the upload dedupes against what is already
-- there (client/js/work.js elsewhere) — which is the invariant working, not
-- the drop failing.
--
-- A job whose atoms another open job is waiting on is refused rather than
-- deleted: dropping it would leave that job waiting on a piece that no longer
-- exists. The tile_event says so (db/0143).
--
-- And the tile keeps its expected_version. See below.
CREATE OR REPLACE FUNCTION drop_job(p_job bigint) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    j job%rowtype;
    n int;
BEGIN
    IF current_user_id() IS NULL THEN
        RAISE EXCEPTION 'authentication required' USING errcode = '28000';
    END IF;
    -- Looked up before it is judged: a job that is already gone is nothing to
    -- be unauthorised for, and dropping it twice should do nothing rather
    -- than say the ground is not yours.
    SELECT * INTO j FROM job WHERE id = p_job FOR UPDATE;
    IF j.id IS NULL OR j.state <> 'open' THEN
        RETURN false;
    END IF;
    IF NOT may_retry_job(p_job) THEN
        RAISE EXCEPTION 'that ground is not yours to drop' USING errcode = '42501';
    END IF;
    SELECT count(*) INTO n FROM atom other
    INNER JOIN job oj ON oj.id = other.job_id AND oj.state = 'open' AND oj.id <> p_job
    WHERE EXISTS (SELECT 1 FROM atom mine
                  WHERE mine.job_id = p_job AND mine.id = ANY (other.deps));
    IF n > 0 THEN
        RAISE EXCEPTION 'another open job is waiting on % piece(s) of this one', n
            USING errcode = '23503';
    END IF;

    PERFORM refund_bounty(p_job);
    -- The tile stops asking, and keeps the version it is at. db/0105 wound
    -- expected_version back to published_version, which is 0 on a tile that
    -- has never published: ensure_job refuses a tile at version 0 ("has no
    -- world input yet"), so dropping a job on unpublished ground made that
    -- ground impossible to compile ever again. Clearing `dirty` is what "the
    -- tile no longer asks for anything" actually needs, and leaves the
    -- version where it is so somebody can ask for it again.
    UPDATE tile SET dirty = false WHERE z = j.z AND x = j.x AND y = j.y;
    DELETE FROM submission_tile st USING submission s
    WHERE s.id = st.submission_id AND s.state = 'open'
      AND st.z = j.z AND st.x = j.x AND st.y = j.y;
    INSERT INTO tile_event (z, x, y, job_id, kind, detail)
    VALUES (j.z, j.x, j.y, j.id, 'gave_up',
            'dropped: the job and its pieces are gone, and compiling this tile'
            || ' again computes them rather than adopting them');
    -- Last: the atoms go with it (atom_job_id_fkey ON DELETE CASCADE).
    DELETE FROM job WHERE id = p_job;
    RETURN true;
END
$$;
