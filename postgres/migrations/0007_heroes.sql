-- postgres/migrations/0007_heroes.sql
-- Volume 4: Heroes, customized per user's design:
--   - 4 factions, assigned randomly at account creation, changeable via a
--     consumable "faction change card" item (see modules/heroes/factions.ts).
--   - "Mirrored roster": every hero exists once per faction. Same
--     hero_family + display_name + base stats across factions (keeps PvP
--     balance — no faction is objectively stronger), but each faction's
--     copy has its OWN unique skill kit (hero_skill_config rows are
--     per-hero_id, and hero_id is per-faction, so skills never collide).
--     Example: hero_family='guardian' has 4 hero_config rows (one per
--     faction), all named "Guardian", all with identical base_attack/
--     base_defense/base_health, but guardian_fire's skills are genuinely
--     different from guardian_water's skills.

CREATE TABLE IF NOT EXISTS faction_config (
    faction_id     TEXT PRIMARY KEY,   -- 'fire' | 'water' | 'earth' | 'air'
    display_name    TEXT NOT NULL
);

INSERT INTO faction_config (faction_id, display_name) VALUES
    ('fire', 'Fire'), ('water', 'Water'), ('earth', 'Earth'), ('air', 'Air')
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS hero_rarity_config (
    rarity                TEXT PRIMARY KEY,
    max_ascension_tier     INT NOT NULL,
    xp_curve_multiplier    NUMERIC NOT NULL DEFAULT 1.0,
    stat_multiplier         NUMERIC NOT NULL DEFAULT 1.0
);

CREATE TABLE IF NOT EXISTS hero_config (
    hero_id                  TEXT PRIMARY KEY,        -- e.g. 'guardian_fire', 'guardian_water'
    hero_family                TEXT NOT NULL,          -- e.g. 'guardian' — links the mirrored copies together
    display_name               TEXT NOT NULL,          -- SAME across a family's factions by design (e.g. "Guardian")
    faction_id                  TEXT NOT NULL REFERENCES faction_config(faction_id),
    rarity                       TEXT NOT NULL REFERENCES hero_rarity_config(rarity),
    role                          TEXT NOT NULL,        -- 'tank' | 'damage' | 'support' | 'commander'
    base_attack                  NUMERIC NOT NULL,
    base_defense                  NUMERIC NOT NULL,
    base_health                   NUMERIC NOT NULL,
    base_march_speed_bonus        NUMERIC NOT NULL DEFAULT 0,
    base_stealth                  NUMERIC NOT NULL DEFAULT 0,
    acquisition_source            TEXT NOT NULL,
    UNIQUE (hero_family, faction_id)  -- exactly one copy of each family per faction
);

CREATE INDEX IF NOT EXISTS idx_hero_config_family ON hero_config (hero_family);
CREATE INDEX IF NOT EXISTS idx_hero_config_faction ON hero_config (faction_id);

CREATE TABLE IF NOT EXISTS hero_skill_config (
    skill_id         TEXT PRIMARY KEY,
    hero_id           TEXT NOT NULL REFERENCES hero_config(hero_id),
    skill_type         TEXT NOT NULL, -- 'active_combat' | 'passive_combat' | 'march' | 'economy'
    max_level          INT NOT NULL DEFAULT 5,
    trigger_condition  TEXT
);

CREATE TABLE IF NOT EXISTS hero_skill_level_config (
    skill_id      TEXT NOT NULL REFERENCES hero_skill_config(skill_id),
    level         INT NOT NULL,
    effect_value  NUMERIC NOT NULL,
    upgrade_cost  JSONB,
    PRIMARY KEY (skill_id, level)
);

CREATE TABLE IF NOT EXISTS hero_ascension_config (
    hero_id                TEXT NOT NULL REFERENCES hero_config(hero_id),
    tier                    INT NOT NULL,
    required_shards          INT NOT NULL,
    required_items           JSONB,
    stat_multiplier_bonus    NUMERIC NOT NULL,
    unlocks_level_cap         INT NOT NULL,
    PRIMARY KEY (hero_id, tier)
);

CREATE TABLE IF NOT EXISTS equipment_config (
    item_id        TEXT PRIMARY KEY,
    display_name    TEXT NOT NULL,
    slot             TEXT NOT NULL,  -- 'weapon' | 'armor' | 'accessory' | 'mount'
    rarity           TEXT NOT NULL REFERENCES hero_rarity_config(rarity),
    base_stat_type   TEXT NOT NULL,  -- 'attack' | 'defense' | 'health'
    base_stat_value  NUMERIC NOT NULL
);

CREATE TABLE IF NOT EXISTS equipment_substat_pool (
    item_id       TEXT NOT NULL REFERENCES equipment_config(item_id),
    substat_key    TEXT NOT NULL,   -- e.g. 'crit_rate'
    min_value      NUMERIC NOT NULL,
    max_value      NUMERIC NOT NULL,
    weight          NUMERIC NOT NULL DEFAULT 1.0,
    PRIMARY KEY (item_id, substat_key)
);

-- Seed rarity tiers (§2.1)
INSERT INTO hero_rarity_config (rarity, max_ascension_tier, xp_curve_multiplier, stat_multiplier) VALUES
    ('common', 2, 1.0, 1.0),
    ('rare', 3, 1.15, 1.2),
    ('epic', 4, 1.3, 1.5),
    ('legendary', 5, 1.5, 2.0)
ON CONFLICT DO NOTHING;