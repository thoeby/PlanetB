-- 0068_approvalfirst.sql — a permit comes before building.
--
-- SPEC §0.2: "Approval comes **before** rendering, like a permit comes before
-- building. What is approved is what stands on the tile (the saved objects and
-- land features, seen in place as models). Rendering is then mechanical: a
-- deterministic compile, hash-checked, that publishes on landing without a
-- second decision."
--
-- db/0044_permission.sql built it the other way round: a stranger rendered
-- first and the owner approved the picture afterwards, as a candidate. That
-- asks somebody to spend minutes of their tab on work that may be thrown away,
-- and asks the owner to judge a render when what they care about is what was
-- built. So: submitting makes a submission, approving opens the render jobs,
-- and a render publishes when it lands.
--
-- The candidate columns on `tile` are left where they are, unwritten: they are
-- what db/0044 meant, and nothing reads them once this is in.

CREATE TABLE submission (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    area_id      uuid NOT NULL REFERENCES area (id) ON DELETE CASCADE,
    by_id        uuid NOT NULL REFERENCES auth.user (id),
    note         text NOT NULL DEFAULT '',
    state        text NOT NULL DEFAULT 'open'
                     CHECK (state IN ('open', 'approved', 'refused')),
    refused_note text,
    created_at   timestamptz NOT NULL DEFAULT now(),
    decided_at   timestamptz,
    decided_by   uuid REFERENCES auth.user (id)
);

CREATE INDEX submission_open ON submission (area_id, state);

-- Which tiles it covers, and what the world said about each of them when it
-- was sent: an approval of what was there is not an approval of what somebody
-- drew afterwards (SPEC §3.6, "superseded").
CREATE TABLE submission_tile (
    submission_id uuid NOT NULL REFERENCES submission (id) ON DELETE CASCADE,
    z             int NOT NULL,
    x             int NOT NULL,
    y             int NOT NULL,
    at_version    bigint NOT NULL,
    PRIMARY KEY (submission_id, z, x, y)
);

ALTER TABLE submission ENABLE ROW LEVEL SECURITY;
ALTER TABLE submission_tile ENABLE ROW LEVEL SECURITY;

-- The world is public to read (db/0003_rls.sql): who submitted what, and what
-- was said about it, is part of what the land says about itself.
CREATE POLICY readable ON submission FOR SELECT TO anon, player, admin USING (true);
CREATE POLICY readable ON submission_tile FOR SELECT TO anon, player, admin
    USING (true);
GRANT SELECT ON submission, submission_tile TO anon, player, admin;

-- What state a tile is in, in the words SPEC §0.2 uses. Derived, never stored:
-- every part of it is already a fact somewhere, and a column would be a second
-- copy to keep true.
CREATE FUNCTION tile_state(t tile) RETURNS text
LANGUAGE sql STABLE SET search_path = public AS $$
SELECT CASE
    WHEN EXISTS (
        SELECT 1 FROM submission s
        JOIN submission_tile st ON st.submission_id = s.id
        WHERE s.state = 'open' AND st.z = t.z AND st.x = t.x AND st.y = t.y)
        THEN 'awaiting approval'
    WHEN EXISTS (
        SELECT 1 FROM job j WHERE j.z = t.z AND j.x = t.x AND j.y = t.y
          AND j.state = 'open' AND j.target_version >= t.expected_version)
        THEN CASE WHEN EXISTS (
            SELECT 1 FROM atom a JOIN job j ON j.id = a.job_id
            WHERE j.z = t.z AND j.x = t.x AND j.y = t.y AND j.state = 'open'
              AND a.state = 'claimed')
            THEN 'rendering' ELSE 'queued' END
    WHEN t.published_version >= t.expected_version AND t.published_version > 0
        THEN 'published'
    WHEN t.dirty AND EXISTS (
        SELECT 1 FROM submission s
        JOIN submission_tile st ON st.submission_id = s.id
        WHERE s.state = 'refused' AND st.z = t.z AND st.x = t.x AND st.y = t.y
          AND s.decided_at > coalesce(t.published_at, s.created_at - interval '1 s'))
        THEN 'refused'
    WHEN t.dirty THEN 'changed'
    ELSE 'ground'
END;
$$;

GRANT EXECUTE ON FUNCTION tile_state(tile) TO anon, player, admin;

-- What is waiting on a piece of land, for the dialog that asks the approver to
-- look at it (SPEC §2.7, §2.9). Counted from the world, not guessed: an object
-- placed since the last publish is "added", one whose rev has moved since is
-- "moved", and a feature drawn since is a change to the land itself.
CREATE FUNCTION submission_changes(p_area uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = public AS $$
SELECT jsonb_build_object(
    'tiles', (SELECT count(*) FROM tile t
              WHERE t.dirty AND t.expected_version > 0
                AND st_intersects((SELECT geom FROM area WHERE id = p_area),
                                  tile_bbox(t.z, t.x, t.y))),
    'objects', (SELECT count(*) FROM instance i
                WHERE i.area_id = p_area AND i.deleted_at IS null),
    'moved', (SELECT count(*) FROM instance i
              WHERE i.area_id = p_area AND i.deleted_at IS null AND i.rev > 1),
    'features', (SELECT count(*) FROM feature f
                 WHERE f.area_id = p_area AND f.deleted_at IS null));
$$;

GRANT EXECUTE ON FUNCTION submission_changes(uuid) TO anon, player, admin;
