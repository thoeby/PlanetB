-- 0127_fournewkindsoffile.sql — four new kinds of file, and nothing else.
--
-- TASKS-foundation.md's ground rules: the work that follows stores four kinds
-- of thing the file store has never held. They arrive here, in one migration,
-- before the stories that write them, so that no later story has to widen a
-- constraint in passing:
--
--   height_edit  a land's painted heights, relative metres (FND.9)
--   cover        a tile's rendered ground: albedo and cover map (FND.12)
--   flow         the ELX of a flow, exactly as a process server reads it (FND.1)
--   material     a surface swatch, a square PNG (FND.5)
--
-- Invariant 1 is untouched: these are immutable content-addressed files like
-- every other, and this only says their names out loud.
ALTER TABLE artifact DROP CONSTRAINT artifact_kind_check;
ALTER TABLE artifact ADD CONSTRAINT artifact_kind_check CHECK (kind IN (
    'glb', 'thumb', 'dem', 'ortho', 'frames', 'init_ply',
    'ply', 'sog', 'height', 'colliders',
    'height_edit', 'cover', 'flow', 'material'));
