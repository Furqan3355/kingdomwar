-- postgres/migrations/0005_freeform_placement.sql
-- Replaces the fixed-slot city system (0002/0003's building_slot table) with
-- freeform placement: buildings get an (x, y) position + a footprint size,
-- validated server-side for grid bounds, overlap, and a buffer-zone gap
-- between structures — same idea as Clash of Clans' placement rules.
--
-- Keeps 0004's Castle-produces-gold change (unrelated to placement, still
-- valid). Does NOT keep 0004's Gold Factory removal decision as a "slot"
-- concept — Gold Factory stays removed (city produces gold directly), that
-- part of 0004 is still correct, just no longer expressed via slots.

-- ============================================================
-- STEP 1: City grid is now 30 wide x 40 tall (was a conceptual 7x7).
-- Stored as project-wide constants here for reference/admin-tooling
-- purposes; the authoritative bounds check lives in placement.ts server
-- code (Postgres doesn't enforce "is this coordinate in bounds", the RPC does).
-- ============================================================
CREATE TABLE IF NOT EXISTS world_config (
    config_key    TEXT PRIMARY KEY,
    config_value  NUMERIC NOT NULL
);
INSERT INTO world_config (config_key, config_value) VALUES
    ('city_grid_width', 30),
    ('city_grid_height', 40),
    ('placement_buffer_tiles', 1)   -- minimum empty gap required between any two buildings
ON CONFLICT (config_key) DO UPDATE SET config_value = EXCLUDED.config_value;

-- ============================================================
-- STEP 2: Building footprint size (replaces building_slot's fixed
-- row_col binding). Every building now declares how many grid tiles it
-- occupies — most are 3x3, City/Academy/Command Center are 5x5.
-- ============================================================
ALTER TABLE building_config
    ADD COLUMN IF NOT EXISTS footprint_width INT NOT NULL DEFAULT 3,
    ADD COLUMN IF NOT EXISTS footprint_height INT NOT NULL DEFAULT 3;

UPDATE building_config SET footprint_width = 5, footprint_height = 5
    WHERE building_id IN ('castle', 'academy', 'command_center');

-- building_slot is no longer used for new placements — freeform (x,y)
-- replaces it. Not dropped yet (keeps history/rollback possible), but no
-- new rows should be added to it going forward. A future cleanup migration
-- can DROP TABLE building_slot once the new system is confirmed working.

-- ============================================================
-- STEP 3: "Ownership" — a building must be unlocked/owned before it can be
-- placed (the shop concept). Separate from placement itself.
-- ============================================================
CREATE TABLE IF NOT EXISTS building_unlock_config (
    building_id           TEXT REFERENCES building_config(building_id) PRIMARY KEY,
    unlock_castle_level    INT NOT NULL,
    -- starter buildings a new player already owns without unlocking via
    -- shop/castle-level — see auth/hooks.ts initializeNewPlayer.
    is_starter_building     BOOLEAN NOT NULL DEFAULT FALSE
);

-- ============================================================
-- STEP 4: Builder Hut and Summon Hut — concurrency-limiting buildings.
-- stat_value = number of concurrent building-upgrade slots this hut
-- contributes (Builder Hut) / concurrent troop-summon slots (Summon Hut).
-- Research and Healing are NOT scaled by hut count — they stay hardcoded
-- to a max of 1 concurrent regardless of hut count (enforced in code, not
-- config, since it's a fixed rule not a per-level tunable).
-- ============================================================
INSERT INTO building_config (building_id, display_name, max_level, category, unlock_castle_level, resource_type, effect_type, footprint_width, footprint_height)
VALUES ('builder_hut', 'Builder Hut', 5, 'utility', 1, NULL, 'concurrency_cap', 3, 3)
ON CONFLICT (building_id) DO NOTHING;

INSERT INTO building_level_config (building_id, level, upgrade_time_seconds, cost_gold, cost_crystal, cost_mithril, stat_value)
VALUES
    ('builder_hut', 1, 0, 0, 0, 0, 1)   -- free starting hut, grants 1 concurrent upgrade slot
ON CONFLICT (building_id, level) DO NOTHING;

INSERT INTO building_config (building_id, display_name, max_level, category, unlock_castle_level, resource_type, effect_type, footprint_width, footprint_height)
VALUES ('summon_hut', 'Summon Hut', 5, 'utility', 1, NULL, 'concurrency_cap', 3, 3)
ON CONFLICT (building_id) DO NOTHING;

INSERT INTO building_level_config (building_id, level, upgrade_time_seconds, cost_gold, cost_crystal, cost_mithril, stat_value)
VALUES
    ('summon_hut', 1, 0, 0, 0, 0, 1)    -- free starting hut, grants 1 concurrent summon slot
ON CONFLICT (building_id, level) DO NOTHING;

-- ============================================================
-- STEP 5: Unlock rules — starting roster (owned immediately, no unlock
-- needed) vs. shop-unlocked (owned once castle level is reached, but
-- must still be manually placed by the player — placement, not ownership,
-- is what's missing for these).
-- ============================================================
INSERT INTO building_unlock_config (building_id, unlock_castle_level, is_starter_building) VALUES
    ('castle', 1, TRUE),
    ('gold_storage', 1, TRUE),
    ('crystal_storage', 1, TRUE),
    ('mithril_storage', 1, TRUE),
    ('builder_hut', 1, TRUE),
    ('summon_hut', 1, TRUE),
    ('crystal_factory', 3, FALSE),
    ('mithril_factory', 8, FALSE),
    ('academy', 2, FALSE),
    ('barracks', 1, FALSE),
    ('hospital', 2, FALSE),
    ('wall', 1, FALSE),
    ('watch_tower', 2, FALSE),
    ('embassy', 3, FALSE),
    ('command_center', 1, FALSE),
    ('defense_tower', 1, FALSE),
    ('cannon', 1, FALSE),
    ('flame_cannon', 2, FALSE),
    ('mine', 1, FALSE)
ON CONFLICT (building_id) DO UPDATE SET
    unlock_castle_level = EXCLUDED.unlock_castle_level,
    is_starter_building = EXCLUDED.is_starter_building;
