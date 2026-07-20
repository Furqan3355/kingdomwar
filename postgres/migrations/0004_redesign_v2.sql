-- postgres/migrations/0004_redesign_v2.sql
-- Redesigns the building roster per new direction:
--   - City/Castle itself produces gold (no separate Gold Factory)
--   - Command Center added (singleton, holds/manages units)
--   - Active defense structures added: Tower, Cannon, Flame Cannon, Mine
--   - Barracks gets multiple buildable slots (already multi-instance capable
--     via the slot system — just adding more slots)
--   - Embassy kept as-is (concept still pending, per Volume 2 shell approach)
--   - Wall kept as-is (already a normal upgradeable building)

-- ============================================================
-- STEP 1: Castle now produces gold directly (dual-purpose: utility +
-- production). This does NOT change Castle's role as the unlock-gate for
-- other buildings (unlock_castle_level / castleLevel sync from Vol.2 §15
-- still works exactly as before) — it just ALSO now has a resource_type
-- and production_rate, same as any production building.
-- ============================================================
UPDATE building_config
SET resource_type = 'gold'
WHERE building_id = 'castle';

UPDATE building_level_config SET production_rate = 4  WHERE building_id = 'castle' AND level = 1;
UPDATE building_level_config SET production_rate = 10 WHERE building_id = 'castle' AND level = 2;
UPDATE building_level_config SET production_rate = 22 WHERE building_id = 'castle' AND level = 3;

-- ============================================================
-- STEP 2: Remove Gold Factory entirely — city itself covers this now.
-- Order matters: level_config and slot rows reference building_config via
-- FK, so delete children first.
-- ============================================================
DELETE FROM building_level_config WHERE building_id = 'gold_factory';
DELETE FROM building_slot WHERE building_id = 'gold_factory';
DELETE FROM building_prerequisite WHERE building_id = 'gold_factory' OR requires_building_id = 'gold_factory';
DELETE FROM building_config WHERE building_id = 'gold_factory';

-- Slots 1_1 and 1_2 (formerly Gold Factory) are now free for future use —
-- intentionally left unbound rather than reassigned here, so a later
-- migration can decide what goes there without this one guessing.

-- ============================================================
-- STEP 3: Command Center — singleton (only one slot exists for it, which
-- is what makes it a singleton; no special "unique building" flag needed,
-- per how the slot system already works).
-- ============================================================
INSERT INTO building_config (building_id, display_name, max_level, category, unlock_castle_level, resource_type, effect_type)
VALUES ('command_center', 'Command Center', 10, 'military', 1, NULL, 'utility')
ON CONFLICT (building_id) DO NOTHING;

INSERT INTO building_level_config (building_id, level, upgrade_time_seconds, cost_gold, cost_crystal, cost_mithril)
VALUES
    ('command_center', 1, 60,  150, 0,  0),
    ('command_center', 2, 240, 400, 0,  0),
    ('command_center', 3, 600, 900, 60, 0)
ON CONFLICT (building_id, level) DO NOTHING;

INSERT INTO building_slot (slot_id, building_id) VALUES ('4_3', 'command_center')
ON CONFLICT (slot_id) DO NOTHING;

-- ============================================================
-- STEP 4: Barracks gets 2 more slots (multi-instance, per direction —
-- Barracks already supports this, just needed more slots bound to it).
-- ============================================================
INSERT INTO building_slot (slot_id, building_id) VALUES
    ('5_5', 'barracks'),
    ('5_6', 'barracks')
ON CONFLICT (slot_id) DO NOTHING;

-- ============================================================
-- STEP 5: Active defense structures — Tower, Cannon, Flame Cannon, Mine.
-- New effect_type 'defense_active' distinguishes these from Wall's passive
-- 'defense_stat' (a %-bonus building) — these are individual structures
-- with their own damage + range, which Volume 6's combat resolver will
-- read when it's built (not yet implemented — these are shells for now,
-- same as Hospital/Barracks were until their owning volumes land).
--
-- Column convention: stat_value = damage, secondary_stat_value = range
-- (in world/grid units — exact meaning finalized when combat is built).
-- ============================================================

-- Tower
INSERT INTO building_config (building_id, display_name, max_level, category, unlock_castle_level, resource_type, effect_type)
VALUES ('defense_tower', 'Tower', 10, 'defense', 1, NULL, 'defense_active')
ON CONFLICT (building_id) DO NOTHING;

INSERT INTO building_level_config (building_id, level, upgrade_time_seconds, cost_gold, cost_crystal, cost_mithril, stat_value, secondary_stat_value)
VALUES
    ('defense_tower', 1, 90,  200, 0,  0, 15, 4),
    ('defense_tower', 2, 300, 500, 30, 0, 32, 5),
    ('defense_tower', 3, 720, 1200, 90, 0, 60, 6)
ON CONFLICT (building_id, level) DO NOTHING;

INSERT INTO building_slot (slot_id, building_id) VALUES
    ('7_1', 'defense_tower'),
    ('7_2', 'defense_tower')
ON CONFLICT (slot_id) DO NOTHING;

-- Cannon
INSERT INTO building_config (building_id, display_name, max_level, category, unlock_castle_level, resource_type, effect_type)
VALUES ('cannon', 'Cannon', 10, 'defense', 1, NULL, 'defense_active')
ON CONFLICT (building_id) DO NOTHING;

INSERT INTO building_level_config (building_id, level, upgrade_time_seconds, cost_gold, cost_crystal, cost_mithril, stat_value, secondary_stat_value)
VALUES
    ('cannon', 1, 90,  200, 0,  0, 25, 3),
    ('cannon', 2, 300, 500, 30, 0, 50, 4),
    ('cannon', 3, 720, 1200, 90, 0, 95, 5)
ON CONFLICT (building_id, level) DO NOTHING;

INSERT INTO building_slot (slot_id, building_id) VALUES
    ('8_1', 'cannon'),
    ('8_2', 'cannon')
ON CONFLICT (slot_id) DO NOTHING;

-- Flame Cannon (higher damage, shorter range than regular Cannon — a
-- reasonable default tradeoff, tune via config pipeline later)
INSERT INTO building_config (building_id, display_name, max_level, category, unlock_castle_level, resource_type, effect_type)
VALUES ('flame_cannon', 'Flame Cannon', 10, 'defense', 2, NULL, 'defense_active')
ON CONFLICT (building_id) DO NOTHING;

INSERT INTO building_level_config (building_id, level, upgrade_time_seconds, cost_gold, cost_crystal, cost_mithril, stat_value, secondary_stat_value)
VALUES
    ('flame_cannon', 1, 120, 300, 20, 0, 40, 2),
    ('flame_cannon', 2, 360, 700, 60, 0, 80, 3),
    ('flame_cannon', 3, 840, 1600, 150, 0, 150, 3)
ON CONFLICT (building_id, level) DO NOTHING;

INSERT INTO building_slot (slot_id, building_id) VALUES ('8_3', 'flame_cannon')
ON CONFLICT (slot_id) DO NOTHING;

-- Mine (one-time trap: explodes once when an attacker enters its range,
-- then is consumed — the "one-time" trigger/reset behavior is combat-
-- resolver logic for Volume 6, not something this migration can express;
-- this only seeds it as a buildable structure with a damage + trigger-range
-- stat, same shell-only pattern as everything else not yet combat-wired).
INSERT INTO building_config (building_id, display_name, max_level, category, unlock_castle_level, resource_type, effect_type)
VALUES ('mine', 'Mine', 5, 'defense', 1, NULL, 'defense_active')
ON CONFLICT (building_id) DO NOTHING;

INSERT INTO building_level_config (building_id, level, upgrade_time_seconds, cost_gold, cost_crystal, cost_mithril, stat_value, secondary_stat_value)
VALUES
    ('mine', 1, 60,  100, 0, 0, 30, 1),
    ('mine', 2, 180, 300, 10, 0, 60, 1),
    ('mine', 3, 420, 700, 40, 0, 110, 2)
ON CONFLICT (building_id, level) DO NOTHING;

INSERT INTO building_slot (slot_id, building_id) VALUES
    ('9_1', 'mine'),
    ('9_2', 'mine'),
    ('9_3', 'mine')
ON CONFLICT (slot_id) DO NOTHING;
