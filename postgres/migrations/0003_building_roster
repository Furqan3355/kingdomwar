-- postgres/migrations/0003_building_roster.sql
-- Completes the Volume 2 §10-11 building roster. 0002 only seeded the
-- resource-chain buildings (Gold/Crystal/Mithril Factory+Storage) and
-- Castle. This migration adds the remaining six buildings, all as
-- "shell only" per Volume 2 §11: buildable/upgradeable in the city (cost,
-- timer, prerequisites, slot), but with NO gameplay effect wired up yet
-- (no research effects, no troop queue, no casualty handling, no combat
-- stat application, no alliance actions) — those land in the volumes
-- listed in §11's "Deferred to" column.
--
-- unlock_castle_level values here are placeholders (same convention as
-- 0001/0002's level 1-3 seed data) — final numbers are a design/config-
-- pipeline decision (Volume 1 §9.2), not something to hardcode as final
-- here.

-- ============================================================
-- Academy — hosts the research tree (tree itself is out of scope, §10)
-- ============================================================
INSERT INTO building_config (building_id, display_name, max_level, category, unlock_castle_level, resource_type, effect_type)
VALUES ('academy', 'Academy', 10, 'utility', 2, NULL, 'utility')
ON CONFLICT (building_id) DO NOTHING;

INSERT INTO building_level_config (building_id, level, upgrade_time_seconds, cost_gold, cost_crystal, cost_mithril)
VALUES
    ('academy', 1, 120, 300,  0,  0),
    ('academy', 2, 360, 800,  50, 0),
    ('academy', 3, 840, 2000, 150, 0)
ON CONFLICT (building_id, level) DO NOTHING;

INSERT INTO building_slot (slot_id, building_id) VALUES ('5_1', 'academy')
ON CONFLICT (slot_id) DO NOTHING;

-- ============================================================
-- Barracks — troop training entry point (queue mechanics: Volume 5)
-- ============================================================
INSERT INTO building_config (building_id, display_name, max_level, category, unlock_castle_level, resource_type, effect_type)
VALUES ('barracks', 'Barracks', 10, 'military', 1, NULL, 'troop_capacity')
ON CONFLICT (building_id) DO NOTHING;

-- stat_value = training queue slots (interpretation owned by Volume 5)
INSERT INTO building_level_config (building_id, level, upgrade_time_seconds, cost_gold, cost_crystal, cost_mithril, stat_value)
VALUES
    ('barracks', 1, 60,  150, 0,  0, 1),
    ('barracks', 2, 240, 400, 0,  0, 2),
    ('barracks', 3, 600, 900, 60, 0, 3)
ON CONFLICT (building_id, level) DO NOTHING;

INSERT INTO building_slot (slot_id, building_id) VALUES ('5_2', 'barracks')
ON CONFLICT (slot_id) DO NOTHING;

-- ============================================================
-- Hospital — wounded-troop capacity (casualty rules: Volume 5/6)
-- ============================================================
INSERT INTO building_config (building_id, display_name, max_level, category, unlock_castle_level, resource_type, effect_type)
VALUES ('hospital', 'Hospital', 10, 'military', 2, NULL, 'troop_capacity')
ON CONFLICT (building_id) DO NOTHING;

-- stat_value = wounded-troop capacity. secondary_stat_value is reserved for
-- heal_rate_per_hour (Volume 1 §7.1 types.ts comment) — left NULL here since
-- healing mechanics are out of scope until Volume 5/6.
INSERT INTO building_level_config (building_id, level, upgrade_time_seconds, cost_gold, cost_crystal, cost_mithril, stat_value)
VALUES
    ('hospital', 1, 90,  200, 0,  0, 100),
    ('hospital', 2, 300, 500, 20, 0, 300),
    ('hospital', 3, 720, 1200, 80, 0, 700)
ON CONFLICT (building_id, level) DO NOTHING;

INSERT INTO building_slot (slot_id, building_id) VALUES ('5_3', 'hospital')
ON CONFLICT (slot_id) DO NOTHING;

-- ============================================================
-- Wall — base defense multiplier (combat application: Volume 6)
-- ============================================================
INSERT INTO building_config (building_id, display_name, max_level, category, unlock_castle_level, resource_type, effect_type)
VALUES ('wall', 'Wall', 10, 'defense', 1, NULL, 'defense_stat')
ON CONFLICT (building_id) DO NOTHING;

-- stat_value = HP/defense bonus %. §9 describes Wall as "always present at
-- level 0" — no special server code needed for that: an unbuilt building
-- (no entry in KingdomState.buildings) already defaults to level 0 in the
-- existing upgrade_building logic (currentLevel = existing ? existing.level : 0).
INSERT INTO building_level_config (building_id, level, upgrade_time_seconds, cost_gold, cost_crystal, cost_mithril, stat_value)
VALUES
    ('wall', 1, 90,  200, 0,  0, 5),
    ('wall', 2, 300, 500, 30, 0, 12),
    ('wall', 3, 720, 1200, 90, 0, 22)
ON CONFLICT (building_id, level) DO NOTHING;

INSERT INTO building_slot (slot_id, building_id) VALUES ('6_1', 'wall')
ON CONFLICT (slot_id) DO NOTHING;

-- ============================================================
-- Watch Tower — scout detection radius (march/scouting: Volume 3/5)
-- ============================================================
INSERT INTO building_config (building_id, display_name, max_level, category, unlock_castle_level, resource_type, effect_type)
VALUES ('watch_tower', 'Watch Tower', 10, 'defense', 2, NULL, 'defense_stat')
ON CONFLICT (building_id) DO NOTHING;

-- stat_value = scout detection radius (tiles), interpretation owned by Volume 3/5
INSERT INTO building_level_config (building_id, level, upgrade_time_seconds, cost_gold, cost_crystal, cost_mithril, stat_value)
VALUES
    ('watch_tower', 1, 90,  200, 0,  0, 3),
    ('watch_tower', 2, 300, 500, 30, 0, 5),
    ('watch_tower', 3, 720, 1200, 90, 0, 8)
ON CONFLICT (building_id, level) DO NOTHING;

INSERT INTO building_slot (slot_id, building_id) VALUES ('6_2', 'watch_tower')
ON CONFLICT (slot_id) DO NOTHING;

-- ============================================================
-- Embassy — alliance-hosted actions (Alliance system: Volume 7)
-- ============================================================
INSERT INTO building_config (building_id, display_name, max_level, category, unlock_castle_level, resource_type, effect_type)
VALUES ('embassy', 'Embassy', 10, 'utility', 3, NULL, 'utility')
ON CONFLICT (building_id) DO NOTHING;

INSERT INTO building_level_config (building_id, level, upgrade_time_seconds, cost_gold, cost_crystal, cost_mithril)
VALUES
    ('embassy', 1, 120, 300,  0,  0),
    ('embassy', 2, 360, 800,  50, 0),
    ('embassy', 3, 840, 2000, 150, 0)
ON CONFLICT (building_id, level) DO NOTHING;

INSERT INTO building_slot (slot_id, building_id) VALUES ('6_3', 'embassy')
ON CONFLICT (slot_id) DO NOTHING;

-- Note: as with 0001/0002, levels 4-10 are intentionally left for design to
-- fill in via the config export pipeline (Volume 1 §9) — no
-- building_prerequisite rows are seeded here either, since Volume 2's
-- "Academy requires Barracks level 3" is presented in the doc as an
-- illustrative example, not a confirmed design decision. The
-- building_prerequisite framework (0002) already supports adding one
-- whenever design confirms the actual requirement.
