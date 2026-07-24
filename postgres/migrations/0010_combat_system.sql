-- postgres/migrations/0010_combat_system.sql
-- Volume 6: Combat System, per the confirmed design in
-- volumedocumentation/vol6.md (as corrected 2026-07-23):
--   - City Attack, Skeleton Village, Resource Tile all use the SAME live
--     battle scene. Only the defender identity and post-battle army
--     placement/loot differ (see world_tile.occupant_data usage in
--     modules/combat/garrison.ts — no new per-tile table needed, this
--     reuses the existing generic occupant_data JSON column from 0006).
--   - Fortress/Temple stay auto-resolved, and their defending side is
--     ALWAYS "NPC garrison + whatever player army is currently stationed
--     there, combined" (confirmed: a lone winner's army does not replace
--     the NPC garrison — both fight together against the next attacker).
--   - Skeleton Village's NPC garrison is fixed per-tile (no regen once
--     defeated, matching the Fortress precedent) — see npc_garrison_config
--     below for the SEED composition used the first time any of these
--     tile types is touched by combat.

CREATE TABLE IF NOT EXISTS npc_garrison_config (
    tile_type   TEXT PRIMARY KEY,   -- 'fortress' | 'temple' | 'neutral_monster' (Skeleton Village)
    troops      JSONB NOT NULL      -- Record<unitId, count> — unit_id refers to unit_config (0008)
);

INSERT INTO npc_garrison_config (tile_type, troops) VALUES
    ('neutral_monster', '{"knight": 80, "archer": 60}'),
    ('fortress',        '{"knight": 300, "archer": 200, "minotaur": 40}'),
    ('temple',          '{"knight": 200, "archer": 150, "mage": 40}')
ON CONFLICT DO NOTHING;

-- One row per resolved fight, regardless of mode (city / skeleton_village /
-- resource_tile / fortress / temple) — `mode` distinguishes them for
-- reporting/UI. defender_user_id is NULL for a pure-NPC defense (Skeleton
-- Village before anyone has ever stationed there, or a Fortress/Temple's
-- NPC-only garrison with no player army added yet).
CREATE TABLE IF NOT EXISTS battle_report (
    report_id           BIGSERIAL PRIMARY KEY,
    shard_id             INT NOT NULL,
    tile_x                INT NOT NULL,
    tile_y                INT NOT NULL,
    tile_type              TEXT NOT NULL,
    mode                     TEXT NOT NULL,   -- 'city_attack' | 'skeleton_village' | 'resource_tile' | 'structure'
    attacker_user_id          TEXT NOT NULL,
    defender_user_id           TEXT,          -- NULL when the defense was pure NPC garrison
    attacker_troops_before      JSONB NOT NULL,
    defender_troops_before       JSONB NOT NULL, -- combined NPC+stationed, per §Fortress rule above
    attacker_losses               JSONB NOT NULL,
    defender_losses                JSONB NOT NULL,
    attacker_survivors               JSONB NOT NULL,
    defender_survivors                JSONB NOT NULL,
    winner                             TEXT NOT NULL, -- 'attacker' | 'defender'
    loot                                 JSONB,        -- ResourceBundle transferred to attacker, if any (§Resource Tile full-wipe rule)
    resolved_tick                         BIGINT NOT NULL,
    created_at                             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_battle_report_attacker ON battle_report (attacker_user_id, resolved_tick DESC);
CREATE INDEX IF NOT EXISTS idx_battle_report_defender ON battle_report (defender_user_id, resolved_tick DESC) WHERE defender_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_battle_report_tile ON battle_report (shard_id, tile_x, tile_y, resolved_tick DESC);