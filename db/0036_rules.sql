-- 0036_rules.sql — what a feature becomes is data, not code.
--
-- A stand of spruce is not spruce because `props.js` has a `SPECIES` constant
-- with "spruce" in it. It is spruce because a rule in this table says: for
-- kind forest, where species is one of these words, build a canopy this wide,
-- this tall, this colour. The same shape as QGIS's rule-based symbology — an
-- ordered list, a filter over the feature's own properties, first match wins —
-- so the vocabulary of a world is the world's, in every language and every
-- schema, and nothing in the compiler knows a single column name.
--
-- `filter` is [{prop, op, value}], every one of them true to match; no
-- conditions is the else-rule. `style` is what the rule produces: a constant,
-- or {"prop": "hoehe", "times": 1, "plus": 0, "min": …, "max": …, "else": …}
-- to read a number off the feature. client/lib/rules.js is the evaluator, and
-- it is the only thing that reads either.

CREATE TABLE build_rule (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name       text NOT NULL,
    kind       text NOT NULL CHECK (kind IN (
                   '*', 'road', 'forest', 'water', 'footprint', 'terrainmod')),
    ordering   int NOT NULL DEFAULT 100,
    filter     jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(filter) = 'array'),
    style      jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(style) = 'object'),
    enabled    boolean NOT NULL DEFAULT true,
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX build_rule_order_idx ON build_rule (kind, ordering, id);

-- The whole rule set as one hash. It goes into every tile's snapshot, so an
-- atom built before a rule changed can tell that the world moved under it
-- (Invariant 2) instead of publishing something nobody asked for.
CREATE FUNCTION rules_digest() RETURNS text
LANGUAGE sql STABLE AS $$
SELECT encode(public.digest(coalesce(string_agg(
    r.id::text || ':' || r.ordering::text || ':' || r.enabled::text || ':'
    || r.kind || ':' || r.filter::text || ':' || r.style::text,
    ',' ORDER BY r.kind, r.ordering, r.id), ''), 'sha256'), 'hex')
FROM build_rule r;
$$;
GRANT EXECUTE ON FUNCTION rules_digest() TO anon, player, admin;

CREATE OR REPLACE FUNCTION world_snapshot(z int, x int, y int) RETURNS text
LANGUAGE sql STABLE STRICT AS $$
SELECT encode(public.digest(
    coalesce(string_agg(sig, ',' ORDER BY sig), '') || E'\nrules:' || rules_digest(),
    'sha256'), 'hex')
FROM (
    SELECT f.id::text || ':' || f.rev::text AS sig
    FROM feature f
    WHERE f.deleted_at IS NULL
      AND st_intersects(f.geom, tile_bbox(z, x, y))
    UNION ALL
    SELECT i.id::text || ':' || i.rev::text
    FROM instance i
    WHERE i.deleted_at IS NULL
      AND st_intersects(i.geom, tile_bbox(z, x, y))
) s;
$$;

-- Invariant 4: a rule change marks tiles dirty and nothing else. Every tile,
-- because a rule is global — which is also why editing one is not free.
CREATE FUNCTION rules_dirty_everything() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    UPDATE tile SET dirty = true, expected_version = expected_version + 1;
    RETURN NULL;
END
$$;
CREATE TRIGGER build_rule_dirty AFTER INSERT OR UPDATE OR DELETE ON build_rule
FOR EACH STATEMENT EXECUTE FUNCTION rules_dirty_everything();

-- The rules are what the world looks like: everyone reads them, an admin
-- writes them (Invariant 6 — through RLS, never through client code).
ALTER TABLE build_rule ENABLE ROW LEVEL SECURITY;
CREATE POLICY read_all ON build_rule FOR SELECT USING (true);
CREATE POLICY admin_writes ON build_rule FOR ALL TO admin
    USING (true) WITH CHECK (true);
GRANT SELECT ON build_rule TO anon, player, admin;
GRANT INSERT, UPDATE, DELETE ON build_rule TO admin;

CREATE VIEW api.build_rule WITH (security_invoker = true) AS
SELECT * FROM public.build_rule;
GRANT SELECT ON api.build_rule TO anon, player, admin;
GRANT INSERT, UPDATE, DELETE ON api.build_rule TO admin;

-- The rules the compiler used to be: db/0013's tile_world — as db/0021 left
-- it, instances carrying the GLB's own digest — now carries them too, in the
-- order the evaluator must read them.
CREATE OR REPLACE FUNCTION tile_world(z int, x int, y int) RETURNS jsonb
LANGUAGE sql STABLE STRICT AS $$
SELECT jsonb_build_object(
    'z', z, 'x', x, 'y', y,
    'snapshot', world_snapshot(z, x, y),
    'rules', coalesce((
        SELECT jsonb_agg(jsonb_build_object(
            'id', r.id, 'name', r.name, 'kind', r.kind, 'ordering', r.ordering,
            'enabled', r.enabled, 'filter', r.filter, 'style', r.style)
            ORDER BY r.kind, r.ordering, r.id)
        FROM build_rule r WHERE r.enabled), '[]'::jsonb),
    'features', coalesce((
        SELECT jsonb_agg(jsonb_build_object(
            'id', f.id, 'kind', f.kind, 'rev', f.rev, 'props', f.props,
            'geom', st_asgeojson(f.geom, 12)::jsonb) ORDER BY f.id)
        FROM feature f
        WHERE f.deleted_at IS NULL
          AND st_intersects(f.geom, tile_bbox(z, x, y))), '[]'::jsonb),
    'instances', coalesce((
        SELECT jsonb_agg(jsonb_build_object(
            'id', i.id, 'san', i.san, 'rev', i.rev, 'props', i.props,
            'sha256', a.sha256, 'canon_version', a.canon_version,
            'lon', i.lon, 'lat', i.lat, 'h', i.h,
            'yaw', i.yaw, 'pitch', i.pitch, 'roll', i.roll,
            'scale', i.scale) ORDER BY i.id)
        FROM instance i
        JOIN asset a ON a.san = i.san
        WHERE i.deleted_at IS NULL
          AND st_intersects(i.geom, tile_bbox(z, x, y))), '[]'::jsonb));
$$;
