-- 0143_atilerememberswhatwentwrong.sql — what happened to a tile is written
-- down, so the panel can show it and it does not scroll away.
--
-- A tab that hit an error logged one line into a panel that keeps the last few
-- and then dropped it. fail_atom put the reason on `atom.result`, where the
-- next attempt overwrote it; submit_atom put the rule that refused a run into
-- `verification.metrics`, which nothing reads. So "error 7 assemble — no
-- ground at 14/8541/5795" existed for as long as somebody was watching, and a
-- tile that had failed three times an hour ago looked the same as one nobody
-- had touched.
--
-- `tile_event` is append-only and public, like `progress` (db/0024): what the
-- world has managed and what it has not is not a secret. One row per outcome,
-- never per step — a training run is 1 200 steps and none of them is an event.
--
-- Written here, inside the transitions themselves, rather than by the tab:
-- a worker cannot forget to write one, cannot write one for work it does not
-- hold, and no new client write is trusted (Invariant 6).
CREATE TABLE tile_event (
    id      bigserial PRIMARY KEY,
    z       int NOT NULL,
    x       int NOT NULL,
    y       int NOT NULL,
    job_id  bigint,
    atom_id bigint,
    op      text,
    kind    text NOT NULL
                CHECK (kind IN ('failed', 'refused', 'handed_back', 'gave_up',
                                'published')),
    detail  text NOT NULL DEFAULT '',
    at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tile_event_tile_idx ON tile_event (z, x, y, id DESC);
CREATE INDEX tile_event_at_idx ON tile_event (at DESC);
ALTER TABLE tile_event ENABLE ROW LEVEL SECURITY;
CREATE POLICY read_all ON tile_event FOR SELECT USING (true);
GRANT SELECT ON tile_event TO anon, player, admin;

CREATE VIEW api.tile_event WITH (security_invoker = true) AS
SELECT * FROM public.tile_event;
GRANT SELECT ON api.tile_event TO anon, player, admin;

-- One outcome, against the tile its job is for. `a_detail` is cut to the same
-- 600 characters fail_atom already keeps, because these are read in a card.
CREATE FUNCTION note_tile_event(a_atom atom, a_kind text, a_detail text DEFAULT '')
RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
INSERT INTO tile_event (z, x, y, job_id, atom_id, op, kind, detail)
SELECT j.z, j.x, j.y, j.id, (a_atom).id, (a_atom).op, a_kind,
       left(coalesce(a_detail, ''), 600)
FROM job j WHERE j.id = (a_atom).job_id;
$$;

REVOKE ALL ON FUNCTION note_tile_event(atom, text, text) FROM PUBLIC;
