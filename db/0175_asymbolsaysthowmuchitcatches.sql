-- 0175_asymbolsaysthowmuchitcatches.sql — the Symbols editor's numbers, so the
-- panel can say what a symbol is rather than only what it was typed as.
--
-- The editor knew a symbol's name, kind and layers and nothing else: not how
-- many features in the world it catches, not which of its versions the world
-- is built with, not who saved one. So "matches nothing at all" and "matches
-- every road in the valley" looked exactly the same while it was being edited,
-- which is the difference that matters.
--
-- `feature_matches` is client/lib/rules.js's matcher, in SQL, over the same
-- conditions db/0161 stores: prop, op, value, and every one of them has to
-- hold. Its comparisons are that file's: as numbers where both sides are
-- numbers, as trimmed lower-case text otherwise, and an absent property is not
-- zero. One matcher in two languages is a thing to keep in step, and the
-- alternative is the editor guessing.
CREATE FUNCTION prop_same(a text, b text) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
    x numeric;
    y numeric;
BEGIN
    BEGIN
        x := replace(btrim(coalesce(a, '')), ',', '.')::numeric;
        y := replace(btrim(coalesce(b, '')), ',', '.')::numeric;
        RETURN x = y;
    EXCEPTION WHEN others THEN
        RETURN lower(btrim(coalesce(a, ''))) = lower(btrim(coalesce(b, '')));
    END;
END
$$;

CREATE FUNCTION prop_num(a text) RETURNS numeric
LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
    IF btrim(coalesce(a, '')) = '' THEN RETURN NULL; END IF;
    RETURN replace(btrim(a), ',', '.')::numeric;
EXCEPTION WHEN others THEN
    RETURN NULL;
END
$$;

-- One condition against one feature's properties. Anything the matcher does
-- not know refuses, rather than catching everything.
CREATE FUNCTION cond_holds(p_props jsonb, p_cond jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
    got  text := p_props #>> ARRAY[p_cond ->> 'prop'];
    op   text := coalesce(p_cond ->> 'op', 'eq');
    want jsonb := p_cond -> 'value';
    said text := CASE WHEN jsonb_typeof(want) = 'string' THEN want #>> '{}'
                      ELSE want #>> '{}' END;
    there boolean := got IS NOT NULL AND btrim(got) <> '';
BEGIN
    RETURN CASE op
        WHEN 'eq' THEN prop_same(got, said)
        WHEN 'ne' THEN NOT prop_same(got, said)
        WHEN 'lt' THEN prop_num(got) < prop_num(said)
        WHEN 'lte' THEN prop_num(got) <= prop_num(said)
        WHEN 'gt' THEN prop_num(got) > prop_num(said)
        WHEN 'gte' THEN prop_num(got) >= prop_num(said)
        WHEN 'has' THEN position(lower(btrim(coalesce(said, '')))
                                 IN lower(btrim(coalesce(got, '')))) > 0
        WHEN 'exists' THEN there
        WHEN 'missing' THEN NOT there
        WHEN 'in' THEN EXISTS (
            SELECT 1 FROM jsonb_array_elements(
                CASE WHEN jsonb_typeof(want) = 'array' THEN want
                     ELSE jsonb_build_array(want) END) AS one
            WHERE prop_same(got, one #>> '{}'))
        ELSE false END;
END
$$;

-- How many features of this kind every condition holds for. A symbol with no
-- conditions catches every feature of its kind, which is what the editor's
-- "a symbol with no conditions catches everything the ones above it left"
-- means; '*' is every kind there is.
CREATE FUNCTION feature_matches(p_kind text, p_filter jsonb) RETURNS bigint
LANGUAGE sql STABLE AS $$
SELECT count(*) FROM feature f
WHERE f.deleted_at IS NULL
  AND (p_kind = '*' OR f.kind = p_kind)
  AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(coalesce(p_filter, '[]'::jsonb)) AS c
      WHERE NOT cond_holds(coalesce(f.props, '{}'::jsonb), c));
$$;

GRANT EXECUTE ON FUNCTION prop_same(text, text), prop_num(text),
    cond_holds(jsonb, jsonb), feature_matches(text, jsonb) TO anon, player, admin;

CREATE FUNCTION api.feature_matches(p_kind text, p_filter jsonb DEFAULT '[]'::jsonb)
RETURNS bigint
LANGUAGE sql STABLE AS $$SELECT public.feature_matches(p_kind, p_filter)$$;
GRANT EXECUTE ON FUNCTION api.feature_matches(text, jsonb) TO anon, player, admin;

-- Every symbol there is, with what the editor's list has to show: how many
-- layers, how many features it catches, and which of its versions the world
-- is built with. `applied` is null where the world has never been built with
-- this symbol at all, and equal to `version` where nothing has changed since.
CREATE FUNCTION symbols_now() RETURNS jsonb
LANGUAGE sql STABLE AS $$
WITH pinned AS (
    SELECT coalesce((SELECT p.symbols FROM style_version p
                     WHERE p.id = (SELECT max(id) FROM style_version)),
                    '{}'::jsonb) AS at
)
SELECT coalesce(jsonb_agg(jsonb_build_object(
    'id', s.id, 'name', s.name, 'kind', s.kind, 'ordering', s.ordering,
    'enabled', s.enabled, 'filter', s.filter, 'layers', s.layers,
    'layer_count', jsonb_array_length(s.layers),
    'version', s.version,
    'applied', (SELECT (at ->> s.id::text)::int FROM pinned),
    'matches', feature_matches(s.kind, s.filter))
    ORDER BY s.kind, s.ordering, s.id), '[]'::jsonb)
FROM symbol s;
$$;
GRANT EXECUTE ON FUNCTION symbols_now() TO anon, player, admin;

CREATE FUNCTION api.symbols_now() RETURNS jsonb
LANGUAGE sql STABLE AS $$SELECT public.symbols_now()$$;
GRANT EXECUTE ON FUNCTION api.symbols_now() TO anon, player, admin;

-- The versions one symbol has been saved as, newest first, each with who saved
-- it and whether it is the one the world is built with. The editor drew this
-- behind a History button that had to be asked for; a version list nobody can
-- see is a version list nobody uses.
CREATE FUNCTION symbol_history(p_symbol uuid) RETURNS jsonb
LANGUAGE sql STABLE AS $$
WITH pinned AS (
    SELECT (coalesce((SELECT p.symbols FROM style_version p
                      WHERE p.id = (SELECT max(id) FROM style_version)),
                     '{}'::jsonb) ->> p_symbol::text)::int AS at
)
SELECT coalesce(jsonb_agg(jsonb_build_object(
    'version', v.version, 'name', v.name, 'filter', v.filter, 'layers', v.layers,
    'saved_at', v.saved_at,
    'who', coalesce(player_name(v.saved_by), 'the world'),
    'mine', v.saved_by IS NOT DISTINCT FROM current_user_id(),
    'in_world', v.version = (SELECT at FROM pinned),
    'current', v.version = (SELECT s.version FROM symbol s WHERE s.id = p_symbol))
    ORDER BY v.version DESC), '[]'::jsonb)
FROM symbol_version v WHERE v.symbol_id = p_symbol;
$$;
GRANT EXECUTE ON FUNCTION symbol_history(uuid) TO anon, player, admin;

CREATE FUNCTION api.symbol_history(p_symbol uuid) RETURNS jsonb
LANGUAGE sql STABLE AS $$SELECT public.symbol_history(p_symbol)$$;
GRANT EXECUTE ON FUNCTION api.symbol_history(uuid) TO anon, player, admin;
