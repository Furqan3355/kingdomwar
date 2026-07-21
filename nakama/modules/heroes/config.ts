// modules/heroes/config.ts
// Read-only lookups against the config tables from 0007_heroes.sql —
// same pattern as economy/config/loader.ts (Volume 1 §5/§9): authoritative
// config lives in Postgres, server re-validates against it on every spend.

export interface HeroConfigRow {
  hero_id: string;
  hero_family: string;
  display_name: string;
  faction_id: string;
  rarity: string;
  role: string;
  base_attack: number;
  base_defense: number;
  base_health: number;
  base_march_speed_bonus: number;
  base_stealth: number;
}

export function getHeroConfig(nk: nkruntime.Nakama, heroId: string): HeroConfigRow | null {
  const result = nk.sqlQuery(
    `SELECT hero_id, hero_family, display_name, faction_id, rarity, role,
            base_attack, base_defense, base_health, base_march_speed_bonus, base_stealth
     FROM hero_config WHERE hero_id = $1`,
    [heroId]
  );
  if (!result || result.length === 0) return null;
  const r = result[0];
  return {
    hero_id: r.hero_id, hero_family: r.hero_family, display_name: r.display_name,
    faction_id: r.faction_id, rarity: r.rarity, role: r.role,
    base_attack: Number(r.base_attack), base_defense: Number(r.base_defense),
    base_health: Number(r.base_health), base_march_speed_bonus: Number(r.base_march_speed_bonus),
    base_stealth: Number(r.base_stealth),
  };
}

// Resolves a hero_family + faction to the faction-specific hero_id — the
// entry point for acquisition (§6.3): design/summon systems deal in
// hero_family ("give the player a Guardian"), this resolves which faction
// copy that player should actually receive.
export function getHeroIdForFamilyAndFaction(nk: nkruntime.Nakama, heroFamily: string, factionId: string): string | null {
  const result = nk.sqlQuery(
    `SELECT hero_id FROM hero_config WHERE hero_family = $1 AND faction_id = $2`,
    [heroFamily, factionId]
  );
  if (!result || result.length === 0) return null;
  return result[0].hero_id;
}

export interface HeroRarityConfigRow {
  rarity: string;
  max_ascension_tier: number;
  xp_curve_multiplier: number;
  stat_multiplier: number;
}

export function getHeroRarityConfig(nk: nkruntime.Nakama, rarity: string): HeroRarityConfigRow | null {
  const result = nk.sqlQuery(
    `SELECT rarity, max_ascension_tier, xp_curve_multiplier, stat_multiplier FROM hero_rarity_config WHERE rarity = $1`,
    [rarity]
  );
  if (!result || result.length === 0) return null;
  const r = result[0];
  return {
    rarity: r.rarity, max_ascension_tier: r.max_ascension_tier,
    xp_curve_multiplier: Number(r.xp_curve_multiplier), stat_multiplier: Number(r.stat_multiplier),
  };
}

export interface HeroAscensionConfigRow {
  hero_id: string;
  tier: number;
  required_shards: number;
  required_items: unknown;
  stat_multiplier_bonus: number;
  unlocks_level_cap: number;
}

export function getHeroAscensionConfig(nk: nkruntime.Nakama, heroId: string, tier: number): HeroAscensionConfigRow | null {
  const result = nk.sqlQuery(
    `SELECT hero_id, tier, required_shards, required_items, stat_multiplier_bonus, unlocks_level_cap
     FROM hero_ascension_config WHERE hero_id = $1 AND tier = $2`,
    [heroId, tier]
  );
  if (!result || result.length === 0) return null;
  const r = result[0];
  return {
    hero_id: r.hero_id, tier: r.tier, required_shards: r.required_shards,
    required_items: r.required_items, stat_multiplier_bonus: Number(r.stat_multiplier_bonus),
    unlocks_level_cap: r.unlocks_level_cap,
  };
}

export interface HeroSkillLevelConfigRow {
  skill_id: string;
  level: number;
  effect_value: number;
  upgrade_cost: unknown;
}

export function getHeroSkillLevelConfig(nk: nkruntime.Nakama, skillId: string, level: number): HeroSkillLevelConfigRow | null {
  const result = nk.sqlQuery(
    `SELECT skill_id, level, effect_value, upgrade_cost FROM hero_skill_level_config WHERE skill_id = $1 AND level = $2`,
    [skillId, level]
  );
  if (!result || result.length === 0) return null;
  const r = result[0];
  return { skill_id: r.skill_id, level: r.level, effect_value: Number(r.effect_value), upgrade_cost: r.upgrade_cost };
}

export function getHeroSkillMaxLevel(nk: nkruntime.Nakama, skillId: string): number | null {
  const result = nk.sqlQuery(`SELECT max_level FROM hero_skill_config WHERE skill_id = $1`, [skillId]);
  if (!result || result.length === 0) return null;
  return result[0].max_level;
}

export interface EquipmentConfigRow {
  item_id: string;
  display_name: string;
  slot: string;
  rarity: string;
  base_stat_type: string;
  base_stat_value: number;
}

export function getEquipmentConfig(nk: nkruntime.Nakama, itemId: string): EquipmentConfigRow | null {
  const result = nk.sqlQuery(
    `SELECT item_id, display_name, slot, rarity, base_stat_type, base_stat_value FROM equipment_config WHERE item_id = $1`,
    [itemId]
  );
  if (!result || result.length === 0) return null;
  const r = result[0];
  return {
    item_id: r.item_id, display_name: r.display_name, slot: r.slot, rarity: r.rarity,
    base_stat_type: r.base_stat_type, base_stat_value: Number(r.base_stat_value),
  };
}