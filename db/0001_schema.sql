-- 0001_schema.sql — world, catalog, money, tiles, jobs (ARCHITECTURE §3).
-- Roles are created here because the grants below need them; WP0.3 puts the
-- auth.user table and login()/register() on top of them.

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        CREATE ROLE anon NOLOGIN;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'player') THEN
        CREATE ROLE player NOLOGIN;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'admin') THEN
        CREATE ROLE admin NOLOGIN;
    END IF;
END
$$;

-- Zoom ladder: only even zooms are materialised (ARCHITECTURE §2).
CREATE DOMAIN zoom AS smallint CHECK (VALUE IN (6, 8, 10, 12, 14, 16, 18));

-- ---------------------------------------------------------------- artifacts

-- Invariant 1: immutable, content-addressed; rows are never updated in place.
CREATE TABLE artifact (
    sha256       text PRIMARY KEY CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    kind         text NOT NULL CHECK (kind IN (
                     'glb', 'thumb', 'dem', 'ortho', 'frames', 'init_ply',
                     'ply', 'sog', 'height', 'colliders')),
    bytes        bigint NOT NULL CHECK (bytes > 0),
    algo_version text NOT NULL,
    created_by   uuid,
    created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX artifact_kind_idx ON artifact (kind);

-- ------------------------------------------------------------------- money

CREATE TABLE account (
    id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    -- null owner = system account (escrow, treasury)
    owner_id uuid UNIQUE
);

-- Invariant 5: append-only. REVOKE stops roles, the trigger stops everyone.
CREATE TABLE ledger (
    id     bigserial PRIMARY KEY,
    at     timestamptz NOT NULL DEFAULT now(),
    debit  uuid NOT NULL REFERENCES account (id),
    credit uuid NOT NULL REFERENCES account (id),
    amount numeric(18, 6) NOT NULL CHECK (amount > 0),
    ref    text NOT NULL UNIQUE,
    CHECK (debit <> credit)
);
CREATE INDEX ledger_debit_idx ON ledger (debit);
CREATE INDEX ledger_credit_idx ON ledger (credit);

CREATE FUNCTION ledger_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    -- Invariant 5: the ledger is append-only, superusers included.
    RAISE EXCEPTION 'ledger is append-only (%)', tg_op;
END
$$;

CREATE TRIGGER ledger_no_update BEFORE UPDATE OR DELETE ON ledger
FOR EACH ROW EXECUTE FUNCTION ledger_append_only();

REVOKE UPDATE, DELETE ON ledger FROM PUBLIC;
REVOKE UPDATE, DELETE ON ledger FROM anon, player, admin;

CREATE VIEW balance AS
SELECT
    a.id AS account_id,
    coalesce((SELECT sum(l.amount) FROM ledger l WHERE l.credit = a.id), 0)
    - coalesce((SELECT sum(l.amount) FROM ledger l WHERE l.debit = a.id), 0)
        AS amount
FROM account a;

-- ------------------------------------------------------------------- world

CREATE TABLE area (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    geom       geometry(Polygon, 4326) NOT NULL,
    owner_id   uuid NOT NULL,
    detail     smallint NOT NULL DEFAULT 14
                   CHECK (detail IN (10, 12, 14, 16, 18)),
    rules      jsonb NOT NULL DEFAULT '{"required_approvals": 1}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX area_geom_idx ON area USING gist (geom);
CREATE INDEX area_owner_idx ON area (owner_id);

CREATE TABLE grant_ (
    area_id    uuid NOT NULL REFERENCES area (id) ON DELETE CASCADE,
    grantee_id uuid NOT NULL,
    right_     text NOT NULL CHECK (right_ IN ('direct_edit', 'edit', 'approve')),
    PRIMARY KEY (area_id, grantee_id, right_)
);
CREATE INDEX grant_grantee_idx ON grant_ (grantee_id);

CREATE TABLE feature (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    area_id    uuid NOT NULL REFERENCES area (id),
    kind       text NOT NULL CHECK (kind IN (
                   'road', 'forest', 'water', 'footprint', 'terrainmod')),
    geom       geometry(GeometryZ, 4326) NOT NULL,
    props      jsonb NOT NULL DEFAULT '{}'::jsonb,
    rev        bigint NOT NULL DEFAULT 1,
    deleted_at timestamptz
);
CREATE INDEX feature_geom_idx ON feature USING gist (geom);
CREATE INDEX feature_area_idx ON feature (area_id);
CREATE INDEX feature_kind_idx ON feature (kind);

-- ------------------------------------------------------------------ catalog

CREATE TABLE asset (
    san           text PRIMARY KEY CHECK (san ~ '^S[A-Z2-7]{12}$'),
    sha256        text NOT NULL REFERENCES artifact (sha256),
    canon_version smallint NOT NULL,
    name          text NOT NULL,
    category      text NOT NULL,
    bbox          jsonb NOT NULL,
    tris          int NOT NULL CHECK (tris >= 0),
    tex_bytes     int NOT NULL CHECK (tex_bytes >= 0),
    license       text NOT NULL CHECK (license IN ('cc0', 'free', 'paid', 'limited')),
    price         numeric(18, 6) NOT NULL DEFAULT 0 CHECK (price >= 0),
    editions      int,
    issued        int NOT NULL DEFAULT 0 CHECK (issued >= 0),
    creator_id    uuid NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    CHECK (editions IS NULL OR issued <= editions),
    CHECK ((license = 'limited') = (editions IS NOT NULL))
);
CREATE INDEX asset_category_idx ON asset (category);
CREATE INDEX asset_creator_idx ON asset (creator_id);

CREATE TABLE asset_right (
    san         text NOT NULL REFERENCES asset (san),
    holder_id   uuid NOT NULL,
    acquired_at timestamptz NOT NULL DEFAULT now(),
    ref         text NOT NULL UNIQUE,
    PRIMARY KEY (san, holder_id)
);
CREATE INDEX asset_right_holder_idx ON asset_right (holder_id);

CREATE TABLE instance (
    id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    area_id uuid NOT NULL REFERENCES area (id),
    san     text NOT NULL REFERENCES asset (san),
    lon     double precision NOT NULL CHECK (lon BETWEEN -180 AND 180),
    lat     double precision NOT NULL CHECK (lat BETWEEN -85.06 AND 85.06),
    h       double precision NOT NULL DEFAULT 0,
    yaw     real NOT NULL DEFAULT 0,
    pitch   real NOT NULL DEFAULT 0,
    roll    real NOT NULL DEFAULT 0,
    scale   real NOT NULL DEFAULT 1 CHECK (scale > 0),
    props      jsonb NOT NULL DEFAULT '{}'::jsonb,
    rev        bigint NOT NULL DEFAULT 1,
    deleted_at timestamptz,
    -- generated so instances land in the same GiST index shape as features
    geom       geometry(Point, 4326)
                   GENERATED ALWAYS AS (st_setsrid(st_makepoint(lon, lat), 4326)) STORED
);
CREATE INDEX instance_geom_idx ON instance USING gist (geom);
CREATE INDEX instance_area_idx ON instance (area_id);
CREATE INDEX instance_san_idx ON instance (san);

-- --------------------------------------------------------------- proposals

CREATE TABLE proposal (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    area_id    uuid NOT NULL REFERENCES area (id),
    author_id  uuid NOT NULL,
    state      text NOT NULL DEFAULT 'open'
                   CHECK (state IN ('open', 'merged', 'rejected')),
    diff       jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX proposal_area_idx ON proposal (area_id, state);

CREATE TABLE approval (
    proposal_id uuid NOT NULL REFERENCES proposal (id) ON DELETE CASCADE,
    reviewer_id uuid NOT NULL,
    at          timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (proposal_id, reviewer_id)
);

-- ------------------------------------------------------------------- tiles

CREATE TABLE tile (
    z                 zoom NOT NULL,
    x                 int NOT NULL CHECK (x >= 0),
    y                 int NOT NULL CHECK (y >= 0),
    dirty             boolean NOT NULL DEFAULT false,
    expected_version  bigint NOT NULL DEFAULT 0,
    published_version bigint NOT NULL DEFAULT 0,
    sog_sha256        text REFERENCES artifact (sha256),
    manifest          jsonb,
    published_at      timestamptz,
    published_by      uuid,
    PRIMARY KEY (z, x, y),
    CHECK (x < (1 << z) AND y < (1 << z)),
    -- Invariant 3: a publish can never run ahead of the world snapshot.
    CHECK (published_version <= expected_version)
);
CREATE INDEX tile_dirty_idx ON tile (dirty) WHERE dirty;
CREATE INDEX tile_published_idx ON tile (z, published_version);

-- -------------------------------------------------------------- jobs/atoms

CREATE TABLE job (
    id             bigserial PRIMARY KEY,
    z              zoom NOT NULL,
    x              int NOT NULL,
    y              int NOT NULL,
    target_version bigint NOT NULL,
    bounty         numeric(18, 6) NOT NULL DEFAULT 0 CHECK (bounty >= 0),
    state          text NOT NULL DEFAULT 'open'
                       CHECK (state IN ('open', 'done', 'cancelled')),
    created_at     timestamptz NOT NULL DEFAULT now(),
    UNIQUE (z, x, y, target_version),
    FOREIGN KEY (z, x, y) REFERENCES tile (z, x, y)
);
CREATE INDEX job_state_idx ON job (state) WHERE state = 'open';

CREATE TABLE worker (
    id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id   uuid NOT NULL,
    caps      jsonb NOT NULL DEFAULT '{}'::jsonb,
    trust     numeric(4, 3) NOT NULL DEFAULT 0.5 CHECK (trust BETWEEN 0 AND 1),
    last_seen timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX worker_user_idx ON worker (user_id);

-- Invariant 2: atom_hash pins op, algo_version, inputs, params and seed, so an
-- atom's identity is its whole computation.
CREATE TABLE atom (
    id            bigserial PRIMARY KEY,
    job_id        bigint NOT NULL REFERENCES job (id) ON DELETE CASCADE,
    atom_hash     text NOT NULL UNIQUE CHECK (atom_hash ~ '^[0-9a-f]{64}$'),
    op            text NOT NULL,
    algo_version  text NOT NULL,
    deps          bigint [] NOT NULL DEFAULT '{}',
    inputs        jsonb NOT NULL DEFAULT '{}'::jsonb,
    params        jsonb NOT NULL DEFAULT '{}'::jsonb,
    seed          int NOT NULL DEFAULT 0,
    state         text NOT NULL DEFAULT 'waiting' CHECK (state IN (
                      'waiting', 'ready', 'claimed', 'submitted', 'verified', 'failed')),
    worker_id     uuid REFERENCES worker (id),
    claimed_at    timestamptz,
    heartbeat_at  timestamptz,
    result        jsonb,
    output_sha256 text REFERENCES artifact (sha256),
    attempts      smallint NOT NULL DEFAULT 0 CHECK (attempts >= 0)
);
CREATE INDEX atom_state_op_idx ON atom (state, op);
CREATE INDEX atom_job_idx ON atom (job_id);

CREATE TABLE worker_op_stats (
    worker_id uuid NOT NULL REFERENCES worker (id) ON DELETE CASCADE,
    op        text NOT NULL,
    ok        int NOT NULL DEFAULT 0 CHECK (ok >= 0),
    bad       int NOT NULL DEFAULT 0 CHECK (bad >= 0),
    PRIMARY KEY (worker_id, op)
);

CREATE TABLE verification (
    atom_id             bigint NOT NULL REFERENCES atom (id) ON DELETE CASCADE,
    verifier_worker_id  uuid REFERENCES worker (id),
    kind                text NOT NULL
                            CHECK (kind IN ('structural', 'hash', 'perceptual')),
    passed              boolean NOT NULL,
    metrics             jsonb NOT NULL DEFAULT '{}'::jsonb,
    at                  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX verification_atom_idx ON verification (atom_id);
CREATE UNIQUE INDEX verification_distinct_worker_idx
ON verification (atom_id, verifier_worker_id)
WHERE kind = 'perceptual' AND verifier_worker_id IS NOT NULL;
