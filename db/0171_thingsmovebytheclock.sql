-- 0171_thingsmovebytheclock.sql — a thing that moves by the world's own clock.
--
-- TASKS-foundation.md FND.16. A bus on a route is not a thing standing on the
-- land: it is a route, a speed and a timetable, and where it is at any moment
-- is worked out from them (client/lib/route.js). So it is never baked into a
-- tile, no tile is dirtied by it, and nobody approves it — a mover changes
-- nothing anybody else has to compile.
--
-- Two players standing at the same stop see the same bus at the same second
-- because both read the same clock: `world_clock()` (db/0168), offset against
-- the tab's own once at load.
--
-- Where it may go: inside the land it belongs to, or along a road that land
-- owns. Somewhere else is somebody else's ground, and a bus through it is a
-- bus nobody agreed to.

CREATE TABLE mover (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    area_id       uuid NOT NULL REFERENCES area (id) ON DELETE CASCADE,
    san           text NOT NULL REFERENCES asset (san),
    name          text NOT NULL DEFAULT '',
    -- A route is a road the land owns, or a line drawn on the ground. One way
    -- or the other, never both and never neither.
    route_feature uuid REFERENCES feature (id) ON DELETE SET NULL,
    route         geometry(LineString, 4326),
    speed_kmh     numeric NOT NULL DEFAULT 30 CHECK (speed_kmh > 0 AND speed_kmh <= 400),
    -- {"every_s": 600, "dwell": [{"at_m": 350, "s": 30}],
    --  "loop": "back_and_forth" | "circle"}
    schedule      jsonb NOT NULL DEFAULT '{"every_s": 600, "loop": "circle"}'::jsonb,
    phase_s       numeric NOT NULL DEFAULT 0,
    paused        boolean NOT NULL DEFAULT false,
    rev           bigint NOT NULL DEFAULT 1,
    deleted_at    timestamptz,
    CHECK ((route_feature IS NULL) <> (route IS NULL))
);

CREATE INDEX mover_area_idx ON mover (area_id);
CREATE INDEX mover_route_idx ON mover USING gist (route);

ALTER TABLE mover ENABLE ROW LEVEL SECURITY;

-- The world is public to read: a bus everybody can see is a bus everybody can
-- read the timetable of.
CREATE POLICY readable ON mover FOR SELECT TO anon, player, admin USING (true);
GRANT SELECT ON mover TO anon, player, admin;

-- Invariant 6: nothing writes this table but `mover_set` and `mover_drop`.

-- What a timetable may say. Everything in it is a number somebody typed, so
-- every one of them is checked before it is stored.
CREATE FUNCTION check_schedule(p_schedule jsonb) RETURNS void
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
    stop jsonb;
BEGIN
    IF coalesce(p_schedule ->> 'loop', 'circle')
       NOT IN ('circle', 'back_and_forth') THEN
        RAISE EXCEPTION 'a route either comes round again or goes back the way'
                        ' it came' USING errcode = '22023';
    END IF;
    IF coalesce((p_schedule ->> 'every_s')::numeric, 600) <= 0 THEN
        RAISE EXCEPTION 'it has to run at least once' USING errcode = '22023';
    END IF;
    FOR stop IN SELECT * FROM jsonb_array_elements(
        coalesce(p_schedule -> 'dwell', '[]'::jsonb)) LOOP
        IF (stop ->> 'at_m') IS NULL OR (stop ->> 's') IS NULL
           OR (stop ->> 'at_m')::numeric < 0 OR (stop ->> 's')::numeric < 0 THEN
            RAISE EXCEPTION 'a stop is so many metres along, for so many seconds'
                USING errcode = '22023';
        END IF;
    END LOOP;
END
$$;

GRANT EXECUTE ON FUNCTION check_schedule(jsonb) TO anon, player, admin;

-- The line a mover runs on, whichever way it was given.
CREATE FUNCTION mover_line(m mover) RETURNS geometry
LANGUAGE sql STABLE SET search_path = public AS $$
SELECT coalesce(m.route,
    (SELECT st_force2d(f.geom) FROM feature f WHERE f.id = m.route_feature));
$$;

GRANT EXECUTE ON FUNCTION mover_line(mover) TO anon, player, admin;

-- Where it may go: inside the land, or along a road that land owns. A metre of
-- slack, because a line drawn on a map is drawn by hand.
CREATE FUNCTION route_is_theirs(p_area uuid, p_line geometry) RETURNS boolean
LANGUAGE sql STABLE SET search_path = public AS $$
SELECT p_line IS NOT NULL
   AND st_covers(st_buffer((SELECT geom FROM area WHERE id = p_area), 0.00002),
                 p_line);
$$;

GRANT EXECUTE ON FUNCTION route_is_theirs(uuid, geometry) TO anon, player, admin;
