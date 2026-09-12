-- 0060_crssaysitonce.sql — finish db/0056: no function body spells a CRS out.
--
-- 0056 put the two EPSG codes in one place per language (world_srid(),
-- tile_srid(), server/splatworld/crs.py, client/lib/crs.js) and left every
-- body written before it spelling 4326 where it runs. Twelve of them did, so
-- the codes were in one place and also in twelve others — which is not one
-- place, and is exactly how a grid drifts apart.
--
-- Every function below is its own definition with the literal replaced by the
-- call, nothing else: same arguments, same body, same volatility. What stays
-- written out is fixed at DDL time and cannot call anything — the generated
-- `geom` column in 0001, the CHECK in 0029, the typmods, and the one-time
-- UPDATE in 0053. server/test_crs_agree.py holds the rest to it by reading
-- the applied catalog, so a new body that spells a code out fails the gate.
CREATE OR REPLACE FUNCTION public.area_at(lon double precision, lat double precision)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
SELECT coalesce(jsonb_agg(public.area_view(a) ORDER BY st_area(a.geom) DESC), '[]'::jsonb)
FROM area a
WHERE st_intersects(a.geom, st_setsrid(st_makepoint(area_at.lon, area_at.lat), world_srid()));
$function$;

CREATE OR REPLACE FUNCTION public.as_lonlat(g geometry)
 RETURNS geometry
 LANGUAGE plpgsql
 IMMUTABLE
AS $function$
DECLARE
    out geometry := g;
BEGIN
    IF g IS null THEN
        RETURN null;
    END IF;
    IF st_srid(g) = 0 THEN
        out := st_setsrid(g, world_srid());
    ELSIF st_srid(g) <> world_srid() THEN
        out := st_transform(g, world_srid());
    END IF;
    IF st_xmin(out) < -180 OR st_xmax(out) > 180
       OR st_ymin(out) < -90 OR st_ymax(out) > 90 THEN
        RAISE EXCEPTION
            'this geometry is not longitude and latitude: x %..%, y %..%',
            round(st_xmin(out)::numeric, 2), round(st_xmax(out)::numeric, 2),
            round(st_ymin(out)::numeric, 2), round(st_ymax(out)::numeric, 2)
            USING errcode = '22023',
                  hint = 'Draw in EPSG:4326, or send the geometry with the SRID'
                         ' it is actually in so it can be converted.';
    END IF;
    RETURN out;
END
$function$;

CREATE OR REPLACE FUNCTION public.bump_rev()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
    a area%rowtype;
    g geometry;
BEGIN
    SELECT * INTO a FROM area WHERE area.id = new.area_id;
    IF tg_table_name = 'instance' THEN
        g := st_setsrid(st_makepoint(new.lon, new.lat), world_srid());
    ELSE
        g := new.geom;
    END IF;
    IF NOT st_intersects(g, a.geom) THEN
        RAISE EXCEPTION 'geometry lies outside area %', new.area_id;
    END IF;
    IF tg_op = 'UPDATE' THEN
        new.rev := old.rev + 1;
    END IF;
    RETURN new;
END
$function$;

CREATE OR REPLACE FUNCTION public.claim_atom(p_caps jsonb DEFAULT '{}'::jsonb)
 RETURNS atom
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    wid   uuid;
    trust numeric;
    a     atom%rowtype;
    ops   text [] := CASE WHEN jsonb_typeof(p_caps -> 'ops') = 'array'
                          THEN ARRAY(SELECT jsonb_array_elements_text(p_caps -> 'ops')) END;
    near  geometry := CASE WHEN jsonb_typeof(p_caps -> 'near') = 'object'
                           THEN st_setsrid(st_makepoint(
                               (p_caps -> 'near' ->> 'lon')::double precision,
                               (p_caps -> 'near' ->> 'lat')::double precision), world_srid()) END;
BEGIN
    PERFORM expire_claims();
    wid := my_worker(p_caps);
    SELECT w.trust INTO trust FROM worker w WHERE w.id = wid;

    SELECT a2.* INTO a
    FROM atom a2
    INNER JOIN job j ON j.id = a2.job_id AND j.state = 'open'
    -- The tile this job compiles, and the version it still wants.
    INNER JOIN tile t ON t.z = j.z AND t.x = j.x AND t.y = j.y
    WHERE a2.state = 'ready'
      AND j.target_version = t.expected_version
      AND (ops IS NULL OR a2.op = ANY(ops))
      AND (NOT coalesce((a2.params ->> 'needs_webgpu')::boolean, false)
           OR coalesce((p_caps ->> 'webgpu')::boolean, false))
      AND coalesce((a2.params ->> 'min_vram_gb')::numeric, 0)
          <= coalesce((p_caps ->> 'vram_gb')::numeric, 0)
      AND coalesce(trust, 0) >= trust_min(a2.op)
      AND (a2.op <> 'verify' OR may_verify(a2.job_id, a2.id, wid))
      AND (a2.op <> 'merge' OR merge_has_a_child(a2.inputs))
    ORDER BY j.bounty DESC,
        -- Nearest first, and only when a position was given: a tile whose DEM,
        -- ortho and children this tab has already fetched is the cheapest work
        -- it can possibly do.
        CASE WHEN near IS NULL THEN 0
             ELSE st_distance(st_centroid(tile_bbox(j.z, j.x, j.y)), near) END,
        a2.id
    FOR UPDATE OF a2 SKIP LOCKED
    LIMIT 1;

    IF a.id IS NULL THEN
        RETURN NULL;
    END IF;

    -- The claim also reserves /jobs/{atom_id}/ for this worker; can_write
    -- (WP0.10) allows uploads there and nowhere else.
    UPDATE atom SET state = 'claimed', worker_id = wid,
                    claimed_at = now(), heartbeat_at = now()
    WHERE id = a.id RETURNING * INTO a;
    RETURN a;
END
$function$;

CREATE OR REPLACE FUNCTION public.create_area(p_geojson jsonb, p_detail integer DEFAULT 0, p_name text DEFAULT ''::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    uid uuid := current_user_id();
    g   geometry;
    aid uuid;
BEGIN
    IF uid IS NULL THEN
        RAISE EXCEPTION 'authentication required' USING errcode = '28000';
    END IF;
    BEGIN
        g := st_setsrid(st_geomfromgeojson(p_geojson), world_srid());
    EXCEPTION WHEN others THEN
        RAISE EXCEPTION 'that is not GeoJSON geometry: %', sqlerrm;
    END;
    IF st_geometrytype(g) <> 'ST_Polygon' THEN
        RAISE EXCEPTION 'an area is one polygon, not %', st_geometrytype(g);
    END IF;
    IF NOT st_isvalid(g) THEN
        RAISE EXCEPTION 'the outline is not valid: %', st_isvalidreason(g);
    END IF;

    -- Overlapping someone else's area is deliberately allowed: 1 037 system
    -- areas cover Switzerland (docs/seed-ch.md), so refusing overlap would
    -- refuse every area a player could draw there. What overlap grants is
    -- ensure_job over those tiles — volunteered browser compute, not a write
    -- on anybody's features, which is_area_writer still decides per area.
    INSERT INTO area (geom, owner_id, detail, rules)
    VALUES (g, uid, p_detail,
            jsonb_build_object('required_approvals', 1)
            || CASE WHEN coalesce(p_name, '') = '' THEN '{}'::jsonb
                    ELSE jsonb_build_object('name', p_name) END)
    RETURNING area.id INTO aid;
    RETURN aid;
END
$function$;

CREATE OR REPLACE FUNCTION public.default_area()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
    IF new.area_id IS NOT NULL THEN
        RETURN new;
    END IF;
    IF tg_table_name = 'instance' THEN
        new.area_id := gis.area_at(st_setsrid(st_makepoint(new.lon, new.lat), world_srid()));
    ELSE
        new.area_id := gis.area_at(new.geom);
    END IF;
    IF new.area_id IS NULL THEN
        RAISE EXCEPTION 'nothing here belongs to an area yet — draw an area '
                        'first, then draw inside it';
    END IF;
    RETURN new;
END;
$function$;

CREATE OR REPLACE FUNCTION public.diff_geom(g jsonb)
 RETURNS geometry
 LANGUAGE sql
 IMMUTABLE
AS $function$
SELECT CASE WHEN jsonb_typeof(g) = 'object'
    THEN st_setsrid(st_force3d(st_geomfromgeojson(g)), world_srid()) END;
$function$;

CREATE OR REPLACE FUNCTION public.my_candidates(p_lon double precision DEFAULT null::double precision, p_lat double precision DEFAULT null::double precision, p_limit integer DEFAULT 40)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
SELECT coalesce(jsonb_agg(c ORDER BY c ->> 'metres', c ->> 'at'), '[]'::jsonb)
FROM (
    SELECT jsonb_build_object(
        'z', t.z, 'x', t.x, 'y', t.y,
        'version', t.candidate_version, 'sha256', t.candidate_sha256,
        'by', t.candidate_by, 'at', t.candidate_at,
        'manifest', t.candidate_manifest,
        'was_published', t.published_version > 0,
        'centre', jsonb_build_object(
            'lon', st_x(st_centroid(tile_bbox(t.z, t.x, t.y))),
            'lat', st_y(st_centroid(tile_bbox(t.z, t.x, t.y)))),
        'metres', CASE WHEN p_lon IS NULL THEN 0 ELSE
            st_distance(st_centroid(tile_bbox(t.z, t.x, t.y))::geography,
                        st_setsrid(st_makepoint(p_lon, p_lat), world_srid())::geography) END) AS c
    FROM tile t
    WHERE t.candidate_sha256 IS NOT NULL AND may_approve_tile(t.z, t.x, t.y)
    LIMIT greatest(p_limit, 0)
) waiting;
$function$;

CREATE OR REPLACE FUNCTION public.render_pool(p_lon double precision DEFAULT null::double precision, p_lat double precision DEFAULT null::double precision, p_limit integer DEFAULT 40)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
SELECT coalesce(jsonb_agg(j ORDER BY j ->> 'ordering'), '[]'::jsonb)
FROM (
    SELECT jsonb_build_object(
        'job', job.id, 'z', job.z, 'x', job.x, 'y', job.y,
        'bounty', job.bounty, 'version', job.target_version,
        'opened_at', job.created_at,
        'ready', (SELECT count(*) FROM atom a
                  WHERE a.job_id = job.id AND a.state IN ('ready', 'waiting')),
        'claimed', (SELECT count(*) FROM atom a
                    WHERE a.job_id = job.id AND a.state = 'claimed'),
        'failed', (SELECT count(*) FROM atom a
                   WHERE a.job_id = job.id AND a.state = 'failed'),
        'may_retry', may_retry_job(job.id),
        'metres', CASE WHEN p_lon IS NULL THEN NULL ELSE
            st_distance(st_centroid(tile_bbox(job.z, job.x, job.y))::geography,
                        st_setsrid(st_makepoint(p_lon, p_lat), world_srid())::geography) END,
        'ordering', lpad((1000000 - least(job.bounty, 999999))::bigint::text, 9, '0')
            || lpad(coalesce(CASE WHEN p_lon IS NULL THEN 0 ELSE
                st_distance(st_centroid(tile_bbox(job.z, job.x, job.y))::geography,
                            st_setsrid(st_makepoint(p_lon, p_lat), world_srid())::geography)
                END, 0)::bigint::text, 12, '0')
            || lpad((18 - job.z)::text, 2, '0')) AS j
    FROM job
    WHERE job.state = 'open'
      -- A job whose every atom has failed still belongs here: it is what
      -- somebody has to look at, and now there is a button for it.
      AND EXISTS (SELECT 1 FROM atom a WHERE a.job_id = job.id
                  AND a.state IN ('ready', 'waiting', 'claimed', 'failed'))
    ORDER BY job.bounty DESC, job.id
    LIMIT greatest(p_limit, 0)
) pool;
$function$;

CREATE OR REPLACE FUNCTION public.set_ground(p_url text, p_coverage text, p_west double precision, p_south double precision, p_east double precision, p_north double precision)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    uid   uuid := current_user_id();
    box   geometry;
    n     int := 0;
    first boolean := NOT EXISTS (SELECT 1 FROM ground);
BEGIN
    IF uid IS NULL THEN
        RAISE EXCEPTION 'authentication required' USING errcode = '28000';
    END IF;
    IF NOT first AND current_user_role() <> 'admin' THEN
        RAISE EXCEPTION 'only an admin moves the world' USING errcode = '42501';
    END IF;
    IF p_west >= p_east OR p_south >= p_north THEN
        RAISE EXCEPTION 'that coverage has no extent';
    END IF;
    IF abs(p_west) > 180 OR abs(p_east) > 180
       OR abs(p_south) > 90 OR abs(p_north) > 90 THEN
        RAISE EXCEPTION 'that extent is not longitude and latitude: % % to % %.'
            ' The coverage published its envelope in its own projection;'
            ' publish it in WGS84 as well, or pick a coverage that does',
            p_west, p_south, p_east, p_north;
    END IF;
    box := st_makeenvelope(greatest(p_west, -180), greatest(p_south, -85.06),
                           least(p_east, 180), least(p_north, 85.06), world_srid());

    INSERT INTO ground (only_one, geoserver_url, coverage, extent, set_by)
    VALUES (true, p_url, p_coverage, box, uid)
    ON CONFLICT (only_one) DO UPDATE
    SET geoserver_url = excluded.geoserver_url, coverage = excluded.coverage,
        extent = excluded.extent, set_at = now(), set_by = excluded.set_by;

    UPDATE tile t SET dirty = true, expected_version = t.expected_version + 1
    WHERE t.expected_version > 0 AND st_intersects(tile_bbox(t.z, t.x, t.y), box);
    GET DIAGNOSTICS n = ROW_COUNT;
    DELETE FROM geo_tile;
    RETURN jsonb_build_object('dirtied', n, 'coverage', p_coverage);
END
$function$;

CREATE OR REPLACE FUNCTION public.tile_bbox(z integer, x integer, y integer)
 RETURNS geometry
 LANGUAGE sql
 IMMUTABLE STRICT
AS $function$
SELECT st_makeenvelope(
    x::double precision / (1 << z) * 360 - 180,
    degrees(atan(sinh(pi() * (1 - 2 * (y + 1)::double precision / (1 << z))))),
    (x + 1)::double precision / (1 << z) * 360 - 180,
    degrees(atan(sinh(pi() * (1 - 2 * y::double precision / (1 << z))))),
    world_srid());
$function$;

CREATE OR REPLACE FUNCTION public.tiles_at(lon double precision, lat double precision, max_z integer DEFAULT 14)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
SELECT coalesce(jsonb_agg(jsonb_build_object(
    'z', t.z, 'x', t.x, 'y', t.y,
    'dirty', t.dirty,
    'expected_version', t.expected_version,
    'published_version', t.published_version,
    'job_id', (SELECT j.id FROM job j
               WHERE j.z = t.z AND j.x = t.x AND j.y = t.y
                 AND j.target_version = t.expected_version AND j.state = 'open')
) ORDER BY t.z), '[]'::jsonb)
FROM tile t
WHERE t.z <= tiles_at.max_z
  AND st_intersects(public.tile_bbox(t.z, t.x, t.y),
                    st_setsrid(st_makepoint(tiles_at.lon, tiles_at.lat), world_srid()));
$function$;
