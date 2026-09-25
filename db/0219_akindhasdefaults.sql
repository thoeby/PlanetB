-- 0219_akindhasdefaults.sql — what a kind is when nobody says otherwise
-- (TASKS-editors.md EDT.23, PLAN-editors.md D4).
--
-- The pickers in Build → Lines and Survey → Areas offer one entry per kind and
-- class, and each entry has a width, a way its corners go, a steepest
-- gradient before its profile goes red, and whether it is offered at all.
-- Until now those came from tables in client/lib/kinds.js. The operator sets
-- them here, per kind; a kind with no row keeps the fallbacks.
--
-- A table of its own rather than columns on `kind`: `kind` is the vocabulary
-- QGIS and the compiler read, and these are the editors' business.
CREATE TABLE kind_default (
    kind       text PRIMARY KEY REFERENCES kind (name) ON UPDATE CASCADE ON DELETE CASCADE,
    -- Metres across, for a line.
    width      real CHECK (width IS NULL OR (width > 0 AND width <= 100)),
    -- True: straight between nodes (a wall); false: curved (a road).
    corner     boolean,
    -- Percent, the steepest a line of it should climb.
    gradient   real CHECK (gradient IS NULL OR (gradient > 0 AND gradient <= 1000)),
    -- Not offered by the pickers; what is already drawn stays.
    hidden     boolean NOT NULL DEFAULT false,
    set_at     timestamptz NOT NULL DEFAULT now()
);

-- Invariant 6: everybody reads them; only an admin writes, through
-- put_kind_default, which says so.
ALTER TABLE kind_default ENABLE ROW LEVEL SECURITY;
CREATE POLICY read_all ON kind_default FOR SELECT USING (true);
GRANT SELECT ON kind_default TO anon, player, admin;

CREATE FUNCTION put_kind_default(p_kind text, p_width real DEFAULT null,
                                 p_corner boolean DEFAULT null,
                                 p_gradient real DEFAULT null,
                                 p_hidden boolean DEFAULT false) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    PERFORM require_admin();
    INSERT INTO kind_default (kind, width, corner, gradient, hidden)
    VALUES (p_kind, p_width, p_corner, p_gradient, coalesce(p_hidden, false))
    ON CONFLICT (kind) DO UPDATE
    SET width = excluded.width, corner = excluded.corner, gradient = excluded.gradient,
        hidden = excluded.hidden, set_at = now();
    RETURN p_kind;
END
$$;

CREATE FUNCTION api.put_kind_default(kind text, width real DEFAULT null,
                                     corner boolean DEFAULT null,
                                     gradient real DEFAULT null,
                                     hidden boolean DEFAULT false) RETURNS text
LANGUAGE sql AS $$SELECT public.put_kind_default(kind, width, corner, gradient, hidden)$$;
-- Executed by the roles it is granted to, not by everybody (db/0216).
REVOKE EXECUTE ON FUNCTION put_kind_default(text, real, boolean, real, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION put_kind_default(text, real, boolean, real, boolean)
TO player, admin;
REVOKE EXECUTE ON FUNCTION api.put_kind_default(text, real, boolean, real, boolean)
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION api.put_kind_default(text, real, boolean, real, boolean)
TO player, admin;

CREATE VIEW api.kind_default WITH (security_invoker = true)
AS SELECT * FROM public.kind_default;
GRANT SELECT ON api.kind_default TO anon, player, admin;
