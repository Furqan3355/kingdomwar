// modules/config/loader.ts
import { BuildingConfigRow, BuildingLevelConfigRow, BuildingPrerequisite, SlotBinding, BuildingUnlockConfigRow, UnitConfigRow, UnitUnlockConfigRow } from '../types';

// These reads hit the *authoritative* config tables described in Volume 1 §5/§9.
// The client's ScriptableObject-derived copy is display-only; every RPC that
// spends resources or applies a timer must re-validate against these rows.

export function getBuildingLevelConfig(
  nk: nkruntime.Nakama,
  buildingId: string,
  level: number
): BuildingLevelConfigRow | null {
  const query = `
    SELECT building_id, level, upgrade_time_seconds, cost_gold, cost_crystal,
           cost_mithril, production_rate, stat_value, secondary_stat_value
    FROM building_level_config
    WHERE building_id = $1 AND level = $2
  `;
  const result = nk.sqlQuery(query, [buildingId, level]);
  if (!result || result.length === 0) {
    return null;
  }
  const row = result[0];
  return {
    building_id: row.building_id,
    level: row.level,
    upgrade_time_seconds: row.upgrade_time_seconds,
    cost_gold: Number(row.cost_gold),
    cost_crystal: Number(row.cost_crystal),
    cost_mithril: Number(row.cost_mithril),
    production_rate: row.production_rate === null ? null : Number(row.production_rate),
    stat_value: row.stat_value === null ? null : Number(row.stat_value),
    secondary_stat_value: row.secondary_stat_value === null ? null : Number(row.secondary_stat_value),
  };
}

export function getBuildingConfig(
  nk: nkruntime.Nakama,
  buildingId: string
): BuildingConfigRow | null {
  const query = `
    SELECT building_id, display_name, max_level, category, unlock_castle_level,
           resource_type, effect_type, footprint_width, footprint_height
    FROM building_config
    WHERE building_id = $1
  `;
  const result = nk.sqlQuery(query, [buildingId]);
  if (!result || result.length === 0) {
    return null;
  }
  const row = result[0];
  return {
    building_id: row.building_id,
    display_name: row.display_name,
    max_level: row.max_level,
    category: row.category,
    unlock_castle_level: row.unlock_castle_level,
    resource_type: row.resource_type,
    effect_type: row.effect_type,
    footprint_width: Number(row.footprint_width),
    footprint_height: Number(row.footprint_height),
  };
}

// Volume 2 §12.2 — cross-building prerequisites (e.g. Academy requires Barracks lvl 3)
export function getBuildingPrerequisites(
  nk: nkruntime.Nakama,
  buildingId: string
): BuildingPrerequisite[] {
  const query = `
    SELECT building_id, requires_building_id, requires_level
    FROM building_prerequisite
    WHERE building_id = $1
  `;
  const result = nk.sqlQuery(query, [buildingId]);
  return (result || []).map((row: any) => ({
    building_id: row.building_id,
    requires_building_id: row.requires_building_id,
    requires_level: row.requires_level,
  }));
}

// Volume 2 §12.3 — which building type is allowed at a given city grid slot
export function getSlotBinding(nk: nkruntime.Nakama, slotId: string): SlotBinding | null {
  const query = `SELECT slot_id, building_id FROM building_slot WHERE slot_id = $1`;
  const result = nk.sqlQuery(query, [slotId]);
  if (!result || result.length === 0) return null;
  return { slot_id: result[0].slot_id, building_id: result[0].building_id };
}

// Sum of stat_value across every built instance of a given resource's storage
// building (Volume 2 §4 — Gold/Crystal/Mithril Storage clamp production to this cap).
export function getWorldConfigValue(nk: nkruntime.Nakama, key: string): number {
  const result = nk.sqlQuery(`SELECT config_value FROM world_config WHERE config_key = $1`, [key]);
  if (!result || result.length === 0) {
    throw Error(`missing world_config value for '${key}' — check 0005 migration ran`);
  }
  return Number(result[0].config_value);
}

export function getBuildingUnlockConfig(nk: nkruntime.Nakama, buildingId: string): BuildingUnlockConfigRow | null {
  const result = nk.sqlQuery(
    `SELECT building_id, unlock_castle_level, is_starter_building FROM building_unlock_config WHERE building_id = $1`,
    [buildingId]
  );
  if (!result || result.length === 0) return null;
  return {
    building_id: result[0].building_id,
    unlock_castle_level: result[0].unlock_castle_level,
    is_starter_building: result[0].is_starter_building,
  };
}

export function getStorageCapForResource(
  nk: nkruntime.Nakama,
  buildings: Record<string, { buildingId: string; level: number }>,
  resourceType: 'gold' | 'crystal' | 'mithril'
): number {
  let total = 0;
  for (const key in buildings) {
    const b = buildings[key];
    const cfg = getBuildingConfig(nk, b.buildingId);
    if (!cfg || cfg.effect_type !== 'storage_cap' || cfg.resource_type !== resourceType) continue;
    const levelCfg = getBuildingLevelConfig(nk, b.buildingId, b.level);
    if (levelCfg && levelCfg.stat_value !== null) total += levelCfg.stat_value;
  }
  return total;
}

// Returns every level 1..N so the client can prefetch a whole upgrade path
// (used by the get_full_state / city-view bootstrap, not on the hot path).
export function getAllBuildingLevels(
  nk: nkruntime.Nakama,
  buildingId: string
): BuildingLevelConfigRow[] {
  const query = `
    SELECT building_id, level, upgrade_time_seconds, cost_gold, cost_crystal,
           cost_mithril, production_rate, stat_value, secondary_stat_value
    FROM building_level_config
    WHERE building_id = $1
    ORDER BY level ASC
  `;
  const result = nk.sqlQuery(query, [buildingId]);
  return (result || []).map((row: any) => ({
    building_id: row.building_id,
    level: row.level,
    upgrade_time_seconds: row.upgrade_time_seconds,
    cost_gold: Number(row.cost_gold),
    cost_crystal: Number(row.cost_crystal),
    cost_mithril: Number(row.cost_mithril),
    production_rate: row.production_rate === null ? null : Number(row.production_rate),
    stat_value: row.stat_value === null ? null : Number(row.stat_value),
    secondary_stat_value: row.secondary_stat_value === null ? null : Number(row.secondary_stat_value),
  }));
}

// --- Volume 5: Army System ---

export function getUnitConfig(nk: nkruntime.Nakama, unitId: string): UnitConfigRow | null {
  const result = nk.sqlQuery(
    `SELECT unit_id, display_name, category, slot_cost, tier, base_attack, base_defense,
            base_health, attack_speed, battlefield_move_speed, train_time_seconds,
            train_cost_gold, train_cost_crystal, train_cost_mithril, upkeep_gold_per_hour,
            heal_time_seconds, heal_cost_gold, heal_cost_crystal, heal_cost_mithril
     FROM unit_config WHERE unit_id = $1`,
    [unitId]
  );
  if (!result || result.length === 0) return null;
  return rowToUnitConfig(result[0]);
}

export function getAllUnitConfigs(nk: nkruntime.Nakama): UnitConfigRow[] {
  const result = nk.sqlQuery(
    `SELECT unit_id, display_name, category, slot_cost, tier, base_attack, base_defense,
            base_health, attack_speed, battlefield_move_speed, train_time_seconds,
            train_cost_gold, train_cost_crystal, train_cost_mithril, upkeep_gold_per_hour,
            heal_time_seconds, heal_cost_gold, heal_cost_crystal, heal_cost_mithril
     FROM unit_config`,
    []
  );
  return (result || []).map(rowToUnitConfig);
}

function rowToUnitConfig(row: any): UnitConfigRow {
  return {
    unit_id: row.unit_id,
    display_name: row.display_name,
    category: row.category,
    slot_cost: Number(row.slot_cost),
    tier: Number(row.tier),
    base_attack: Number(row.base_attack),
    base_defense: Number(row.base_defense),
    base_health: Number(row.base_health),
    attack_speed: Number(row.attack_speed),
    battlefield_move_speed: Number(row.battlefield_move_speed),
    train_time_seconds: Number(row.train_time_seconds),
    train_cost_gold: Number(row.train_cost_gold),
    train_cost_crystal: Number(row.train_cost_crystal),
    train_cost_mithril: Number(row.train_cost_mithril),
    upkeep_gold_per_hour: Number(row.upkeep_gold_per_hour),
    heal_time_seconds: Number(row.heal_time_seconds),
    heal_cost_gold: Number(row.heal_cost_gold),
    heal_cost_crystal: Number(row.heal_cost_crystal),
    heal_cost_mithril: Number(row.heal_cost_mithril),
  };
}

export function getUnitUnlockConfig(nk: nkruntime.Nakama, unitId: string): UnitUnlockConfigRow | null {
  const result = nk.sqlQuery(
    `SELECT unit_id, unlock_castle_level FROM unit_unlock_config WHERE unit_id = $1`,
    [unitId]
  );
  if (!result || result.length === 0) return null;
  return { unit_id: result[0].unit_id, unlock_castle_level: Number(result[0].unlock_castle_level) };
}

export function getLowestPopulationOpenShard(nk: nkruntime.Nakama): number {
  const query = `
    SELECT s.shard_id, COUNT(m.user_id) AS pop
    FROM kingdom_shard s
    LEFT JOIN player_shard_membership m ON m.shard_id = s.shard_id
    WHERE s.status = 'active'
    GROUP BY s.shard_id
    ORDER BY pop ASC
    LIMIT 1
  `;
  const result = nk.sqlQuery(query, []);
  if (!result || result.length === 0) {
    throw Error('no active shard available — seed kingdom_shard table');
  }
  return Number(result[0].shard_id);
}
