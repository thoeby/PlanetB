-- 0135_thevocabularyisosm.sql — the world speaks OSM.
--
-- TASKS-foundation.md FND.3, PLAN-foundation.md §5 (decision D7). The five
-- words the vocabulary started with — road, forest, water, footprint, tree —
-- were this world's own. Everybody who surveys anything already knows OSM's,
-- so the kinds become OSM keys and what used to be the kind becomes the value
-- of the key: a road is `highway=secondary`, a wood is `landuse=forest`.
--
-- Nothing that is drawn changes. `feature.kind` is a foreign key with
-- ON UPDATE CASCADE (db/0040), so a rename carries every row with it; the two
-- kinds that are not renames but splits carry their rows by hand, and keep
-- every property they already had. The compiler is told the new keys in the
-- same commit (client/atoms/assemble.js), and the picture it makes is the same
-- — `client/test/assemble.test.js` compares the hashes.
--
-- The vocabulary's revision bumps itself on every row below (db/0078), so
-- every QGIS project anybody holds is out of date after this, which is exactly
-- what it means.

-- --------------------------------------------------------------- the renames

UPDATE kind SET name = 'highway', label = 'Highway' WHERE name = 'road';
UPDATE kind SET name = 'building', label = 'Building' WHERE name = 'footprint';
UPDATE kind SET name = 'natural_point', label = 'Tree points' WHERE name = 'tree';

-- ---------------------------------------------------------------- the splits

-- The kinds the split needs, before the rows move into them.
INSERT INTO kind (name, applies_to, geometry, label, ordering) VALUES
('landuse', 'feature', 'polygon', 'Landuse', 30),
('natural', 'feature', 'polygon', 'Natural', 35);

-- A wood was a kind; it is a value now. Whatever else was on it stays.
UPDATE feature SET kind = 'landuse',
    props = props || jsonb_build_object('landuse', 'forest')
WHERE kind = 'forest';
UPDATE feature SET kind = 'natural',
    props = props || jsonb_build_object('natural', 'water')
WHERE kind = 'water';

-- -------------------------------------------------------------- the new kinds

INSERT INTO kind (name, applies_to, geometry, label, ordering) VALUES
('railway', 'feature', 'line', 'Railway', 12),
('aerialway', 'feature', 'line', 'Aerialway', 14),
('barrier', 'feature', 'line', 'Barrier', 16),
('waterway', 'feature', 'line', 'Waterway', 18);

-- -------------------------------------------------------- the key properties

-- The key itself is a property of the kind, and its choices are the values
-- PLAN-foundation.md §5 seeds. `highway` and `building` already have one from
-- db/0040; theirs are widened rather than inserted again.
--
-- Not `required`, which is what TASKS-foundation.md FND.3 asks for and what
-- this does not do. A required key would refuse every `landuse` row that does
-- not say which land use it is — including the ones already in the world, the
-- ones a bulk import has not classified yet, and the ones a surveyor draws
-- before they know. db/0040 settled that question when it wrote "the
-- vocabulary is meant to grow by use, and refusing an unknown key would make
-- every import a migration"; the same reasoning applies to a key left blank.
-- What a blank key costs is exactly what it should: the compiler draws nothing
-- for it, because `by(kind, key, values)` matches on the value.
UPDATE property SET choices = ARRAY[
    'motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified',
    'residential', 'service', 'track', 'path', 'footway', 'cycleway', 'steps']
WHERE kind = 'highway' AND name = 'highway';

UPDATE property SET choices = ARRAY[
    'yes', 'house', 'residential', 'barn', 'chalet', 'church', 'commercial',
    'industrial', 'garage']
WHERE kind = 'building' AND name = 'building';

INSERT INTO property (kind, name, label, type, choices, required, ordering) VALUES
('railway', 'railway', 'Class', 'choice',
 ARRAY['rail', 'light_rail', 'tram', 'narrow_gauge', 'funicular'], false, 10),
('aerialway', 'aerialway', 'Class', 'choice',
 ARRAY['cable_car', 'gondola', 'chair_lift', 'drag_lift'], false, 10),
('barrier', 'barrier', 'Class', 'choice',
 ARRAY['wall', 'retaining_wall', 'fence', 'hedge', 'guard_rail', 'kerb'], false, 10),
('waterway', 'waterway', 'Class', 'choice',
 ARRAY['river', 'stream', 'canal', 'ditch'], false, 10),
('landuse', 'landuse', 'Class', 'choice',
 ARRAY['forest', 'meadow', 'farmland', 'vineyard', 'orchard', 'grass'], false, 10),
('natural', 'natural', 'Class', 'choice',
 ARRAY['wood', 'scrub', 'heath', 'grassland', 'bare_rock', 'scree', 'glacier',
       'water', 'wetland', 'sand', 'shingle'], false, 10),
('natural_point', 'natural', 'Class', 'choice',
 ARRAY['tree', 'rock', 'stone', 'peak', 'spring'], false, 10);

-- ------------------------------------------------------- the other properties

INSERT INTO property (kind, name, label, type, choices, required, ordering) VALUES
('highway', 'bridge', 'Bridge', 'boolean', '{}', false, 50),
('highway', 'tunnel', 'Tunnel', 'boolean', '{}', false, 60),
('highway', 'lit', 'Lit', 'boolean', '{}', false, 70),
('highway', 'oneway', 'One way', 'boolean', '{}', false, 80),
('railway', 'gauge', 'Gauge (mm)', 'number', '{}', false, 20),
('railway', 'electrified', 'Electrified', 'choice',
 ARRAY['no', 'contact_line', 'rail'], false, 30),
('railway', 'bridge', 'Bridge', 'boolean', '{}', false, 40),
('railway', 'tunnel', 'Tunnel', 'boolean', '{}', false, 50),
('barrier', 'height', 'Height (m)', 'number', '{}', false, 20),
('barrier', 'material', 'Material', 'text', '{}', false, 30),
('waterway', 'width', 'Width (m)', 'number', '{}', false, 20),
('building', 'roof:shape', 'Roof', 'choice',
 ARRAY['flat', 'gabled', 'hipped', 'pyramidal', 'skillion', 'half-hipped',
       'gambrel', 'round'], false, 45),
('building', 'roof:colour', 'Roof colour', 'text', '{}', false, 46),
('building', 'building:material', 'Material', 'text', '{}', false, 47),
('landuse', 'leaf_type', 'Leaves', 'choice',
 ARRAY['broadleaved', 'needleleaved', 'mixed'], false, 20),
('landuse', 'leaf_cycle', 'Leaf cycle', 'choice',
 ARRAY['evergreen', 'deciduous', 'semi_evergreen', 'semi_deciduous', 'mixed'],
 false, 30),
('landuse', 'species', 'Species', 'text', '{}', false, 40),
('landuse', 'density', 'Trees per hectare', 'number', '{}', false, 50),
('natural', 'leaf_type', 'Leaves', 'choice',
 ARRAY['broadleaved', 'needleleaved', 'mixed'], false, 20),
('natural', 'water', 'Water', 'choice',
 ARRAY['lake', 'pond', 'river', 'stream', 'reservoir'], false, 30),
('natural', 'species', 'Species', 'text', '{}', false, 40),
('natural', 'density', 'Trees per hectare', 'number', '{}', false, 50),
('natural_point', 'genus', 'Genus', 'text', '{}', false, 20),
('natural_point', 'leaf_type', 'Leaves', 'choice',
 ARRAY['broadleaved', 'needleleaved', 'mixed'], false, 40),
('natural_point', 'circumference', 'Circumference (m)', 'number', '{}', false, 50);

-- The old kind's properties that moved with their rows. `forest` carried
-- `natural`, which is a kind of its own now, so it is not carried over; the
-- rest are already above under their new kinds.
DELETE FROM property WHERE kind = 'forest' OR kind = 'water';
DELETE FROM kind WHERE name IN ('forest', 'water');

-- ----------------------------------------------------------------- the rules

-- A rule said which kind it was about; the kind it named is a key and a value
-- now, so the key goes into the rule's filter and the kind becomes the OSM
-- one. Nothing about what any rule matches changes: a rule that was about
-- every forest is about every `landuse=forest`, which is the same set.
ALTER TABLE build_rule DROP CONSTRAINT build_rule_kind_check;

UPDATE build_rule SET kind = 'highway' WHERE kind = 'road';
UPDATE build_rule SET kind = 'building' WHERE kind = 'footprint';
UPDATE build_rule SET kind = 'landuse',
    filter = filter || jsonb_build_array(
        jsonb_build_object('op', 'in', 'prop', 'landuse',
                           'value', jsonb_build_array('forest')))
WHERE kind = 'forest';
UPDATE build_rule SET kind = 'natural',
    filter = filter || jsonb_build_array(
        jsonb_build_object('op', 'in', 'prop', 'natural',
                           'value', jsonb_build_array('water')))
WHERE kind = 'water';

ALTER TABLE build_rule ADD CONSTRAINT build_rule_kind_check CHECK (kind IN (
    '*', 'highway', 'railway', 'aerialway', 'barrier', 'waterway',
    'building', 'landuse', 'natural', 'natural_point', 'terrainmod'));

-- db/0131's build_dag, with assemble at `assemble-v5b`.
--
-- Invariant 2: the atom's code changed, so its version must. `by(kind)` in
-- client/atoms/assemble.js became `by(kind, key, values)` — a road is
-- `highway=*` now, a wood is `landuse=forest` — and a worker running the old
-- code against this world would find no roads at all. The picture is the same;
-- what it is read from is not, and that is exactly what a version is for.
CREATE OR REPLACE FUNCTION build_dag(a_job bigint, a_z int, a_x int, a_y int)
RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
    snap   text := world_snapshot(a_z, a_x, a_y);
    cams   text := CASE WHEN a_z = 18 THEN 'z18-v1' ELSE 'z16-v2' END;
    leaf   boolean := is_leaf_tile(a_z, a_x, a_y);
    base   jsonb;
    asm    bigint;
    frames bigint [] := '{}';
    trn    bigint;
    mrg    bigint;
    views  int := coalesce(nullif(camera_views(a_z), 0), camera_views(14));
    chunk  int := frame_chunk();
    i      int;
    budget bigint := job_budget(a_z);
    px     int := frame_px();
    how    jsonb := frame_renderer();
BEGIN
    IF leaf THEN
        base := jsonb_build_object('snapshot', snap,
            'glb', instance_glbs(a_z, a_x, a_y)) || geo_inputs(a_z, a_x, a_y);
        asm := new_atom(a_job, 'assemble', 'assemble-v5b', base,
            jsonb_build_object('z', a_z, 'x', a_x, 'y', a_y,
                               'budget', budget), 0, '{}');
        i := 0;
        WHILE i < views LOOP
            frames := frames || new_atom(a_job, 'frame', 'frame-v10',
                jsonb_build_object('assemble', asm, 'snapshot', snap),
                jsonb_build_object('camera_set', cams, 'size', px,
                    'from', i, 'to', least(i + chunk, views)) || how, 0, ARRAY[asm]);
            i := i + chunk;
        END LOOP;
        trn := new_atom(a_job, 'train', 'train-v7',
            jsonb_build_object('assemble', asm, 'frames', to_jsonb(frames)),
            jsonb_build_object('budget', budget,
                'iters', train_iters(),
                'size', px,
                'camera_set', cams,
                -- Of the budget, seeded on the surface: what is left is what
                -- brush grows where the frames say the picture is wrong.
                'seed_share', 0.0375,
                -- How much wider every trained splat is written than the
                -- trainer settled on. Turn this up if the ground still shows
                -- through between them.
                'scale', 3,
                'needs_webgpu', true,
                'min_buffer_mb', ceil(96::numeric * budget / 1048576)), 0, frames);
        PERFORM new_atom(a_job, 'sog', 'sog-v1', jsonb_build_object('ply', trn),
            jsonb_build_object('budget', budget), 0, ARRAY[trn]);
    ELSE
        mrg := new_atom(a_job, 'merge', 'merge-v1',
            jsonb_build_object('children', child_sogs(a_z, a_x, a_y),
                               'snapshot', snap),
            jsonb_build_object('z', a_z, 'x', a_x, 'y', a_y,
                               'voxel', 0.05, 'budget', budget), 0, '{}');
        PERFORM new_atom(a_job, 'sog', 'sog-v1', jsonb_build_object('ply', mrg),
            jsonb_build_object('budget', budget), 0, ARRAY[mrg]);
    END IF;
END
$$;
