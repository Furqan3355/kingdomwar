-- postgres/migrations/0008_army_system.sql
-- Volume 5: Army System (custom redesign, per user's final confirmed spec —
-- see volumedocumentation/vol5.md for the written design notes).
--
-- Deviates from the ORIGINAL vol5.md doc in three important ways:
--   1. No archetype rock-paper-scissors triangle. Custom fixed roster:
--      Melee (knight/destroyer/minotaur), Range (archer/mage/tempest),
--      Elite (lavabomb/mammoth/reaper/anubus).
--   2. Elite units consume 3 "slots" everywhere a count is capped (army
--      cap, march size, garrison size) instead of 1. Non-elite = 1 slot.
--   3. World-map march speed stays the FIXED CONSTANT from Volume 3
--      (worldmap/marches.ts SECONDS_PER_TILE) — it is NOT unit-composition
--      dependent. This migration does not touch march speed at all.
--      Per-unit battlefield movement (Clash-of-Clans-style, inside an
--      actual fight) is Volume 6's territory — this volume only stores the
--      data column (battlefield_move_speed) for Volume 6 to consume later.

CREATE TABLE IF NOT EXISTS unit_config (
    unit_id                 TEXT PRIMARY KEY,
    display_name             TEXT NOT NULL,
    category                  TEXT NOT NULL,   -- 'melee' | 'range' | 'elite'
    slot_cost                  INT NOT NULL DEFAULT 1, -- elite = 3, everything else = 1 (§ Elite slots rule)
    tier                        INT NOT NULL,
    base_attack                NUMERIC NOT NULL,
    base_defense                NUMERIC NOT NULL,
    base_health                  NUMERIC NOT NULL,
    attack_speed                 NUMERIC NOT NULL DEFAULT 1.0,     -- Vol6 combat data, unused by Vol5 logic
    battlefield_move_speed        NUMERIC NOT NULL DEFAULT 1.0,     -- Vol6 combat data, NOT world-map march speed
    train_time_seconds             INT NOT NULL,
    train_cost_gold                 BIGINT NOT NULL,
    train_cost_crystal               BIGINT NOT NULL,
    train_cost_mithril                BIGINT NOT NULL,
    upkeep_gold_per_hour               NUMERIC NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS unit_unlock_config (
    unit_id              TEXT PRIMARY KEY REFERENCES unit_config(unit_id),
    unlock_castle_level   INT NOT NULL
);

INSERT INTO unit_config
  (unit_id, display_name, category, slot_cost, tier, base_attack, base_defense, base_health,
   attack_speed, battlefield_move_speed, train_time_seconds, train_cost_gold, train_cost_crystal, train_cost_mithril, upkeep_gold_per_hour)
VALUES
  -- Melee
  ('knight',    'Knight',    'melee', 1, 1, 12, 14, 120, 1.0, 1.0,  20, 40,  0,  0, 0.02),
  ('destroyer', 'Destroyer', 'melee', 1, 2, 22, 20, 180, 1.0, 0.9,  45, 90,  20, 0, 0.05),
  ('minotaur',  'Minotaur',  'melee', 1, 3, 34, 28, 260, 0.9, 0.8,  90, 180, 60, 10, 0.09),
  -- Range
  ('archer',    'Archer',    'range', 1, 1, 14, 6,  70,  1.1, 1.0,  20, 40,  0,  0, 0.02),
  ('mage',      'Mage',      'range', 1, 2, 24, 8,  90,  0.9, 0.9,  45, 90,  20, 0, 0.05),
  ('tempest',   'Tempest',   'range', 1, 3, 36, 10, 120, 0.8, 0.8,  90, 180, 60, 10, 0.09),
  -- Elite (slot_cost = 3, per the Elite-slots rule)
  ('lavabomb',  'Lavabomb',  'elite', 3, 4, 80, 40, 500, 0.7, 0.7, 180, 400, 150, 60, 0.25),
  ('mammoth',   'Mammoth',   'elite', 3, 4, 70, 60, 650, 0.6, 0.6, 180, 400, 150, 60, 0.25),
  ('reaper',    'Reaper',    'elite', 3, 5, 95, 35, 480, 0.9, 0.9, 220, 520, 200, 90, 0.30),
  ('anubus',    'Anubus',    'elite', 3, 5, 85, 50, 560, 0.75, 0.75, 220, 520, 200, 90, 0.30)
ON CONFLICT DO NOTHING;

INSERT INTO unit_unlock_config (unit_id, unlock_castle_level) VALUES
  ('knight', 1), ('archer', 1),
  ('destroyer', 5), ('mage', 5),
  ('minotaur', 10), ('tempest', 10),
  ('lavabomb', 15), ('mammoth', 15),
  ('reaper', 20), ('anubus', 20)
ON CONFLICT DO NOTHING;

-- ============================================================
-- REINFORCEMENT GARRISONS (Temple / Fortress / Citadel only)
-- ============================================================
-- Reinforcement is only possible on these three world-map structure types,
-- never on plain player castles. Garrisons are keyed by (shard_id, x, y) —
-- same shared-world-data reasoning as world_tile in 0006_world_map.sql
-- (range/lookup queries, not a per-player collection).
CREATE TABLE IF NOT EXISTS structure_garrison (
    shard_id       INT NOT NULL REFERENCES kingdom_shard(shard_id),
    x              INT NOT NULL,
    y              INT NOT NULL,
    user_id        UUID NOT NULL,      -- whose troops these are
    troops         JSONB NOT NULL DEFAULT '{}',
    sent_tick      BIGINT NOT NULL,
    PRIMARY KEY (shard_id, x, y, user_id)
);
CREATE INDEX IF NOT EXISTS idx_structure_garrison_tile ON structure_garrison (shard_id, x, y);

-- ============================================================
-- WORLD_CONFIG defaults for this volume
-- ============================================================
-- Global render-group cap (§ Unit Size / Render Grouping): total visual
-- groups on a battlefield/city-attack scene, across ALL unit types
-- combined, never exceeds this. Not a per-player value — a fixed design
-- constant, consistent with how other engine-wide caps live in
-- world_config (see config/loader.ts getWorldConfigValue).
INSERT INTO world_config (config_key, config_value) VALUES
  ('max_render_groups', 50)
ON CONFLICT (config_key) DO NOTHING;