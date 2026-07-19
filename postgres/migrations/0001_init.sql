-- postgres/migrations/0001_init.sql
-- Custom tables per Volume 1 §5. Nakama's own tables (users, storage,
-- groups, etc.) are managed by `nakama migrate up` and are NOT touched here.

CREATE TABLE IF NOT EXISTS building_config (
    building_id         TEXT PRIMARY KEY,
    display_name         TEXT NOT NULL,
    max_level            INT NOT NULL,
    category              TEXT NOT NULL, -- 'production' | 'military' | 'defense' | 'utility'
    unlock_castle_level   INT NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS building_level_config (
    building_id           TEXT REFERENCES building_config(building_id),
    level                 INT NOT NULL,
    upgrade_time_seconds  INT NOT NULL,
    cost_gold              BIGINT NOT NULL,
    cost_crystal            BIGINT NOT NULL,
    cost_mithril            BIGINT NOT NULL,
    production_rate       NUMERIC, -- null for non-production buildings
    PRIMARY KEY (building_id, level)
);

CREATE TABLE IF NOT EXISTS kingdom_shard (
    shard_id      SERIAL PRIMARY KEY,
    shard_name    TEXT NOT NULL,
    opened_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    closes_at     TIMESTAMPTZ,
    status        TEXT NOT NULL DEFAULT 'active' -- 'active' | 'merging' | 'closed'
);

CREATE TABLE IF NOT EXISTS player_shard_membership (
    user_id       UUID NOT NULL,
    shard_id      INT REFERENCES kingdom_shard(shard_id),
    joined_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, shard_id)
);

CREATE INDEX IF NOT EXISTS idx_player_shard_membership_shard
    ON player_shard_membership (shard_id);

-- Seed: one open shard so new-player initialization has somewhere to land.
INSERT INTO kingdom_shard (shard_name, status)
VALUES ('Kingdom 1', 'active')
ON CONFLICT DO NOTHING;

-- Seed: one production building (Gold Factory) with 3 levels, enough to
-- exercise the full upgrade RPC path end to end per the Volume 1
-- definition-of-done checklist. Volume 2 will seed the complete building
-- roster (Crystal/Mithril Factory & Storage, Castle, Academy, Barracks,
-- Hospital, Wall, Watch Tower, Embassy).
INSERT INTO building_config (building_id, display_name, max_level, category, unlock_castle_level)
VALUES ('gold_factory', 'Gold Factory', 10, 'production', 1)
ON CONFLICT (building_id) DO NOTHING;

INSERT INTO building_level_config
    (building_id, level, upgrade_time_seconds, cost_gold, cost_crystal, cost_mithril, production_rate)
VALUES
    ('gold_factory', 1, 30,  0,   0,  0, 5),
    ('gold_factory', 2, 120, 200, 0,  0, 12),
    ('gold_factory', 3, 300, 500, 50, 0, 25)
ON CONFLICT (building_id, level) DO NOTHING;
