-- postgres/migrations/0002_city_system.sql
-- Implements Volume 2's schema extensions + seeds the starting production
-- roster: Gold/Crystal/Mithril Factory + Storage, so a new player's city
-- actually has something to build beyond the single gold_factory from 0001.

ALTER TABLE building_config
    ADD COLUMN IF NOT EXISTS resource_type TEXT,             -- 'gold' | 'crystal' | 'mithril' | NULL
    ADD COLUMN IF NOT EXISTS effect_type TEXT NOT NULL DEFAULT 'production';
    -- effect_type: 'production' | 'storage_cap' | 'troop_capacity' | 'defense_stat' | 'utility'

ALTER TABLE building_level_config
    ADD COLUMN IF NOT EXISTS stat_value NUMERIC,             -- storage cap / troop capacity / defense stat, per effect_type
    ADD COLUMN IF NOT EXISTS secondary_stat_value NUMERIC;   -- Hospital only: heal_rate_per_hour

CREATE TABLE IF NOT EXISTS building_prerequisite (
    building_id            TEXT REFERENCES building_config(building_id),
    requires_building_id   TEXT REFERENCES building_config(building_id),
    requires_level         INT NOT NULL,
    PRIMARY KEY (building_id, requires_building_id)
);

CREATE TABLE IF NOT EXISTS building_slot (
    slot_id      TEXT PRIMARY KEY,
    building_id  TEXT REFERENCES building_config(building_id)
);

-- Backfill existing gold_factory row with its resource_type (it predates this column)
UPDATE building_config SET resource_type = 'gold', effect_type = 'production' WHERE building_id = 'gold_factory';

-- Give gold_factory its second slot per Volume 2 §3 (two instances allowed)
INSERT INTO building_slot (slot_id, building_id) VALUES
    ('1_1', 'gold_factory'),
    ('1_2', 'gold_factory')
ON CONFLICT (slot_id) DO NOTHING;

-- ============================================================
-- Gold Storage
-- ============================================================
INSERT INTO building_config (building_id, display_name, max_level, category, unlock_castle_level, resource_type, effect_type)
VALUES ('gold_storage', 'Gold Storage', 10, 'production', 1, 'gold', 'storage_cap')
ON CONFLICT (building_id) DO NOTHING;

INSERT INTO building_level_config (building_id, level, upgrade_time_seconds, cost_gold, cost_crystal, cost_mithril, stat_value)
VALUES
    ('gold_storage', 1, 30,  0,   0,  0, 2000),
    ('gold_storage', 2, 120, 150, 0,  0, 5000),
    ('gold_storage', 3, 300, 400, 40, 0, 12000)
ON CONFLICT (building_id, level) DO NOTHING;

INSERT INTO building_slot (slot_id, building_id) VALUES ('1_3', 'gold_storage')
ON CONFLICT (slot_id) DO NOTHING;

-- ============================================================
-- Crystal Factory (unlocks at castle level 3, per Volume 2 §5)
-- ============================================================
INSERT INTO building_config (building_id, display_name, max_level, category, unlock_castle_level, resource_type, effect_type)
VALUES ('crystal_factory', 'Crystal Factory', 10, 'production', 3, 'crystal', 'production')
ON CONFLICT (building_id) DO NOTHING;

INSERT INTO building_level_config (building_id, level, upgrade_time_seconds, cost_gold, cost_crystal, cost_mithril, production_rate)
VALUES
    ('crystal_factory', 1, 60,  100, 0,  0, 2),
    ('crystal_factory', 2, 180, 300, 0,  0, 6),
    ('crystal_factory', 3, 420, 700, 100, 0, 14)
ON CONFLICT (building_id, level) DO NOTHING;

INSERT INTO building_slot (slot_id, building_id) VALUES ('2_1', 'crystal_factory')
ON CONFLICT (slot_id) DO NOTHING;

-- ============================================================
-- Crystal Storage
-- ============================================================
INSERT INTO building_config (building_id, display_name, max_level, category, unlock_castle_level, resource_type, effect_type)
VALUES ('crystal_storage', 'Crystal Storage', 10, 'production', 3, 'crystal', 'storage_cap')
ON CONFLICT (building_id) DO NOTHING;

INSERT INTO building_level_config (building_id, level, upgrade_time_seconds, cost_gold, cost_crystal, cost_mithril, stat_value)
VALUES
    ('crystal_storage', 1, 60,  100, 0, 0, 500),
    ('crystal_storage', 2, 180, 300, 0, 0, 1500),
    ('crystal_storage', 3, 420, 700, 80, 0, 4000)
ON CONFLICT (building_id, level) DO NOTHING;

INSERT INTO building_slot (slot_id, building_id) VALUES ('2_2', 'crystal_storage')
ON CONFLICT (slot_id) DO NOTHING;

-- ============================================================
-- Mithril Factory (unlocks at castle level 8, per Volume 2 §7)
-- ============================================================
INSERT INTO building_config (building_id, display_name, max_level, category, unlock_castle_level, resource_type, effect_type)
VALUES ('mithril_factory', 'Mithril Factory', 10, 'production', 8, 'mithril', 'production')
ON CONFLICT (building_id) DO NOTHING;

INSERT INTO building_level_config (building_id, level, upgrade_time_seconds, cost_gold, cost_crystal, cost_mithril, production_rate)
VALUES
    ('mithril_factory', 1, 300,  2000, 500, 0, 1),
    ('mithril_factory', 2, 900,  5000, 1200, 0, 3),
    ('mithril_factory', 3, 2100, 12000, 3000, 100, 7)
ON CONFLICT (building_id, level) DO NOTHING;

INSERT INTO building_slot (slot_id, building_id) VALUES ('3_1', 'mithril_factory')
ON CONFLICT (slot_id) DO NOTHING;

-- ============================================================
-- Mithril Storage
-- ============================================================
INSERT INTO building_config (building_id, display_name, max_level, category, unlock_castle_level, resource_type, effect_type)
VALUES ('mithril_storage', 'Mithril Storage', 10, 'production', 8, 'mithril', 'storage_cap')
ON CONFLICT (building_id) DO NOTHING;

INSERT INTO building_level_config (building_id, level, upgrade_time_seconds, cost_gold, cost_crystal, cost_mithril, stat_value)
VALUES
    ('mithril_storage', 1, 300,  2000, 500, 0, 200),
    ('mithril_storage', 2, 900,  5000, 1200, 0, 500),
    ('mithril_storage', 3, 2100, 12000, 3000, 80, 1200)
ON CONFLICT (building_id, level) DO NOTHING;

INSERT INTO building_slot (slot_id, building_id) VALUES ('3_2', 'mithril_storage')
ON CONFLICT (slot_id) DO NOTHING;

-- ============================================================
-- Castle (the progression spine — max level 15, per Volume 2 §9)
-- ============================================================
INSERT INTO building_config (building_id, display_name, max_level, category, unlock_castle_level, resource_type, effect_type)
VALUES ('castle', 'Castle', 15, 'utility', 1, NULL, 'utility')
ON CONFLICT (building_id) DO NOTHING;

INSERT INTO building_level_config (building_id, level, upgrade_time_seconds, cost_gold, cost_crystal, cost_mithril)
VALUES
    ('castle', 1, 0,   0,    0,   0),   -- level 1 is the free starting castle
    ('castle', 2, 300, 300, 0,   0),    -- affordable with the 500 starting gold, so the reference test script can complete this step
    ('castle', 3, 900, 3000, 200, 0)
ON CONFLICT (building_id, level) DO NOTHING;

INSERT INTO building_slot (slot_id, building_id) VALUES ('4_4', 'castle')
ON CONFLICT (slot_id) DO NOTHING;

-- Note: levels 4-15 intentionally left for design to fill in via the config
-- export pipeline (Volume 1 §9) — seeding here stops at 3 for every building,
-- enough to exercise/test the full upgrade path without hand-writing 10-15
-- rows per building in a reference migration.
