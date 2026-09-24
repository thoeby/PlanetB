-- 0194_aflowbelongstoathing.sql — a flow may belong to one placed thing.
--
-- TASKS-flows.md FL.6 ("add a process to an object"), which approves the
-- column and the new save_flow overload. A flow is still on a land (db/0155)
-- and still read and written by the land's rules; the thing it belongs to is
-- one more fact about it — which object's panel lists it, and which object its
-- World blocks point at unless told otherwise.
--
-- A thing taken away soft-deletes its instance row, so the flow keeps
-- pointing at it and the page says "was on <thing>". A row really removed sets
-- the pointer to null.

ALTER TABLE flow
ADD COLUMN instance_id uuid REFERENCES instance (id) ON DELETE SET NULL;
CREATE INDEX flow_instance_idx ON flow (instance_id) WHERE instance_id IS NOT NULL;

-- The view was made with * when the table had no such column, and a view's *
-- is expanded once, when it is made.
CREATE OR REPLACE VIEW api.flow WITH (security_invoker = true) AS
SELECT * FROM public.flow;

-- The overload that also says which thing the flow belongs to (null: none).
-- The six-argument save_flow is unchanged and leaves instance_id alone, so a
-- rename or a layout save does not detach anything (CLAUDE.md: an RPC
-- signature is not changed; this is a new one beside it).
CREATE FUNCTION save_flow(p_id uuid, p_area uuid, p_name text,
                          p_elx_sha256 text, p_layout jsonb,
                          p_rev bigint, p_instance uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    done  jsonb;
    thing text;
    land  text;
BEGIN
    IF p_instance IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM instance i
        WHERE i.id = p_instance AND i.area_id = p_area AND i.deleted_at IS NULL) THEN
        SELECT coalesce(a.name, i.san) INTO thing
        FROM instance i LEFT JOIN asset a ON a.san = i.san WHERE i.id = p_instance;
        SELECT coalesce(ar.rules ->> 'name', 'this land') INTO land
        FROM area ar WHERE ar.id = p_area;
        RAISE EXCEPTION '% is not on %.', coalesce(thing, 'That thing'),
            coalesce(land, 'this land');
    END IF;
    -- Invariant 6: every check save_flow makes, it makes here too.
    done := save_flow(p_id, p_area, p_name, p_elx_sha256, p_layout, p_rev);
    UPDATE flow SET instance_id = p_instance WHERE flow.id = (done ->> 'id')::uuid;
    RETURN done;
END
$$;
GRANT EXECUTE ON FUNCTION save_flow(uuid, uuid, text, text, jsonb, bigint, uuid)
TO player, admin;

CREATE FUNCTION api.save_flow(id uuid, area uuid, name text, elx_sha256 text,
                              layout jsonb, rev bigint, instance uuid) RETURNS jsonb
LANGUAGE sql VOLATILE
AS $$SELECT public.save_flow(id, area, name, elx_sha256, layout, rev, instance)$$;
GRANT EXECUTE ON FUNCTION api.save_flow(uuid, uuid, text, text, jsonb, bigint, uuid)
TO player, admin;
