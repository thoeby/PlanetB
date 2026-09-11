-- 0037_ruleseed.sql — the vocabulary the compiler used to have hard-coded.
--
-- Everything here was a constant in client/lib/props.js until 0036: the
-- species table, the words that mean a species in four languages, which column
-- holds an age, which words mean a gabled roof, "height or storeys times three
-- or six metres". None of it belongs in code — it is one world's idea of its
-- own data, and the next world's is different. It is seeded so a fresh world
-- builds something sensible, and every row can be edited or deleted in
-- /app/rules.html without touching the compiler.
--
-- Order matters: first match wins, so the catch-alls sort last (999).

INSERT INTO build_rule (name, kind, ordering, filter, style) VALUES
('spruce', 'forest', 10, '[{"prop": "species", "op": "in", "value": ["spruce", "picea", "fichte", "epicea", "\u00e9pic\u00e9a"]}]'::jsonb, '{"sides": 6, "taper": 0.24, "height": [18, 30], "mature": 70, "color": [0.1, 0.25, 0.15], "age_prop": "age"}'::jsonb),
('fir', 'forest', 20, '[{"prop": "species", "op": "in", "value": ["fir", "abies", "tanne", "weisstanne", "sapin"]}]'::jsonb, '{"sides": 6, "taper": 0.26, "height": [20, 32], "mature": 80, "color": [0.11, 0.27, 0.17], "age_prop": "age"}'::jsonb),
('pine', 'forest', 30, '[{"prop": "species", "op": "in", "value": ["pine", "pinus", "foehre", "f\u00f6hre", "kiefer"]}]'::jsonb, '{"sides": 6, "taper": 0.34, "height": [15, 26], "mature": 60, "color": [0.16, 0.29, 0.14], "age_prop": "age"}'::jsonb),
('larch', 'forest', 40, '[{"prop": "species", "op": "in", "value": ["larch", "larix", "laerche", "l\u00e4rche", "meleze", "m\u00e9l\u00e8ze"]}]'::jsonb, '{"sides": 6, "taper": 0.3, "height": [16, 28], "mature": 65, "color": [0.22, 0.36, 0.15], "age_prop": "age"}'::jsonb),
('beech', 'forest', 50, '[{"prop": "species", "op": "in", "value": ["beech", "fagus", "buche", "hetre", "h\u00eatre"]}]'::jsonb, '{"sides": 7, "taper": 0.62, "height": [14, 24], "mature": 90, "color": [0.21, 0.4, 0.16], "age_prop": "age"}'::jsonb),
('oak', 'forest', 60, '[{"prop": "species", "op": "in", "value": ["oak", "quercus", "eiche", "chene", "ch\u00eane"]}]'::jsonb, '{"sides": 7, "taper": 0.7, "height": [12, 22], "mature": 110, "color": [0.19, 0.36, 0.15], "age_prop": "age"}'::jsonb),
('birch', 'forest', 70, '[{"prop": "species", "op": "in", "value": ["birch", "betula", "birke", "bouleau"]}]'::jsonb, '{"sides": 6, "taper": 0.48, "height": [10, 18], "mature": 50, "color": [0.28, 0.45, 0.2], "age_prop": "age"}'::jsonb),
('maple', 'forest', 80, '[{"prop": "species", "op": "in", "value": ["maple", "acer", "ahorn", "erable", "\u00e9rable"]}]'::jsonb, '{"sides": 7, "taper": 0.64, "height": [11, 20], "mature": 80, "color": [0.24, 0.42, 0.18], "age_prop": "age"}'::jsonb),
('poplar', 'forest', 90, '[{"prop": "species", "op": "in", "value": ["poplar", "populus", "pappel", "peuplier"]}]'::jsonb, '{"sides": 6, "taper": 0.38, "height": [16, 28], "mature": 40, "color": [0.26, 0.44, 0.19], "age_prop": "age"}'::jsonb),
('willow', 'forest', 100, '[{"prop": "species", "op": "in", "value": ["willow", "salix", "weide", "saule"]}]'::jsonb, '{"sides": 7, "taper": 0.72, "height": [8, 14], "mature": 40, "color": [0.25, 0.43, 0.21], "age_prop": "age"}'::jsonb),
('broadleaved', 'forest', 900, '[{"prop": "leaf_type", "op": "in", "value": ["broadleaved", "broadleaf", "deciduous", "laubwald", "laub"]}]'::jsonb, '{"sides": 6, "taper": 0.55, "height": [9, 17], "mature": 80, "color": [0.2, 0.4, 0.16], "age_prop": "age"}'::jsonb),
('any forest', 'forest', 999, '[]'::jsonb, '{"sides": 6, "taper": 0.28, "height": [12, 22], "mature": 70, "color": [0.12, 0.28, 0.16], "age_prop": "age"}'::jsonb),
('gabled roof', 'footprint', 10, '[{"prop": "roof", "op": "in", "value": ["gable", "gabled", "satteldach", "pitched"]}]'::jsonb, '{"roof": "gable", "height": {"prop": "height", "else": {"prop": "levels", "times": 3, "else": 6}}}'::jsonb),
('hipped roof', 'footprint', 20, '[{"prop": "roof", "op": "in", "value": ["hip", "hipped", "pyramidal", "walmdach", "zeltdach"]}]'::jsonb, '{"roof": "hip", "height": {"prop": "height", "else": {"prop": "levels", "times": 3, "else": 6}}}'::jsonb),
('any building', 'footprint', 999, '[]'::jsonb, '{"roof": "flat", "height": {"prop": "height", "else": {"prop": "levels", "times": 3, "else": 6}}}'::jsonb),
('any road', 'road', 999, '[]'::jsonb, '{"width": {"prop": "width", "min": 2, "max": 40, "else": 5}}'::jsonb),
('any terrainmod', 'terrainmod', 999, '[]'::jsonb, '{"amount": {"prop": "amount", "else": 0}, "op": {"prop": "op", "text": true, "else": "flatten"}}'::jsonb);
