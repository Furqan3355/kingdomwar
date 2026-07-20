"use strict";

// modules/config/loader.ts
function getBuildingLevelConfig(nk, buildingId, level) {
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
    secondary_stat_value: row.secondary_stat_value === null ? null : Number(row.secondary_stat_value)
  };
}
function getBuildingConfig(nk, buildingId) {
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
    footprint_height: Number(row.footprint_height)
  };
}
function getBuildingPrerequisites(nk, buildingId) {
  const query = `
    SELECT building_id, requires_building_id, requires_level
    FROM building_prerequisite
    WHERE building_id = $1
  `;
  const result = nk.sqlQuery(query, [buildingId]);
  return (result || []).map((row) => ({
    building_id: row.building_id,
    requires_building_id: row.requires_building_id,
    requires_level: row.requires_level
  }));
}
function getWorldConfigValue(nk, key) {
  const result = nk.sqlQuery(`SELECT config_value FROM world_config WHERE config_key = $1`, [key]);
  if (!result || result.length === 0) {
    throw Error(`missing world_config value for '${key}' \u2014 check 0005 migration ran`);
  }
  return Number(result[0].config_value);
}
function getBuildingUnlockConfig(nk, buildingId) {
  const result = nk.sqlQuery(
    `SELECT building_id, unlock_castle_level, is_starter_building FROM building_unlock_config WHERE building_id = $1`,
    [buildingId]
  );
  if (!result || result.length === 0) return null;
  return {
    building_id: result[0].building_id,
    unlock_castle_level: result[0].unlock_castle_level,
    is_starter_building: result[0].is_starter_building
  };
}
function getStorageCapForResource(nk, buildings, resourceType) {
  let total = 0;
  for (const key in buildings) {
    const b = buildings[key];
    const cfg = getBuildingConfig(nk, b.buildingId);
    if (!cfg || cfg.effect_type !== "storage_cap" || cfg.resource_type !== resourceType) continue;
    const levelCfg = getBuildingLevelConfig(nk, b.buildingId, b.level);
    if (levelCfg && levelCfg.stat_value !== null) total += levelCfg.stat_value;
  }
  return total;
}
function getLowestPopulationOpenShard(nk) {
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
    throw Error("no active shard available \u2014 seed kingdom_shard table");
  }
  return Number(result[0].shard_id);
}

// modules/types.ts
var KINGDOM_COLLECTION = "kingdom";
var KINGDOM_KEY = "state";

// modules/economy/resources.ts
function readKingdomState(nk, userId) {
  const objects = nk.storageRead([
    { collection: KINGDOM_COLLECTION, key: KINGDOM_KEY, userId }
  ]);
  if (!objects || objects.length === 0) {
    return null;
  }
  return objects[0].value;
}
function resolveProductionInMemory(nk, state) {
  const nowSeconds = Math.floor(Date.now() / 1e3);
  const elapsed = Math.max(0, nowSeconds - state.lastCalculatedTick);
  if (elapsed === 0) {
    return state;
  }
  let goldRate = 0;
  let crystalRate = 0;
  let mithrilRate = 0;
  for (const key in state.buildings) {
    const b = state.buildings[key];
    if (b.upgradeFinishTick !== null) continue;
    const buildingCfg = getBuildingConfig(nk, b.buildingId);
    if (!buildingCfg || !buildingCfg.resource_type) continue;
    const levelCfg = getBuildingLevelConfig(nk, b.buildingId, b.level);
    if (!levelCfg || levelCfg.production_rate === null) continue;
    if (buildingCfg.resource_type === "gold") goldRate += levelCfg.production_rate;
    else if (buildingCfg.resource_type === "crystal") crystalRate += levelCfg.production_rate;
    else if (buildingCfg.resource_type === "mithril") mithrilRate += levelCfg.production_rate;
  }
  const goldCap = getStorageCapForResource(nk, state.buildings, "gold");
  const crystalCap = getStorageCapForResource(nk, state.buildings, "crystal");
  const mithrilCap = getStorageCapForResource(nk, state.buildings, "mithril");
  state.resources.gold = clamp(state.resources.gold + elapsed * goldRate, goldCap);
  state.resources.crystal = clamp(state.resources.crystal + elapsed * crystalRate, crystalCap);
  state.resources.mithril = clamp(state.resources.mithril + elapsed * mithrilRate, mithrilCap);
  state.lastCalculatedTick = nowSeconds;
  return state;
}
function clamp(value, cap) {
  if (cap <= 0) return value;
  return Math.min(value, cap);
}
function writeKingdomState(nk, userId, state, version) {
  const write = {
    collection: KINGDOM_COLLECTION,
    key: KINGDOM_KEY,
    userId,
    value: state,
    permissionRead: 1,
    // owner read only
    permissionWrite: 0
    // no direct client writes — server only, per §2.1
  };
  if (version) {
    write.version = version;
  }
  nk.storageWrite([write]);
}
function readAndResolveKingdomState(nk, userId) {
  const state = readKingdomState(nk, userId);
  if (!state) {
    throw Error(`kingdom state not found for user ${userId} \u2014 afterAuthenticate hook should have created it`);
  }
  const resolved = resolveProductionInMemory(nk, state);
  writeKingdomState(nk, userId, resolved);
  return resolved;
}

// modules/economy/buildings.ts
function rpcUpgradeBuilding(ctx, logger, nk, payload) {
  const userId = ctx.userId;
  if (!userId) {
    return respond({ ok: false, error: "unauthenticated" });
  }
  let req;
  try {
    req = JSON.parse(payload);
  } catch (e) {
    return respond({ ok: false, error: "invalid_payload" });
  }
  if (!req.buildingId || !req.slot) {
    return respond({ ok: false, error: "missing_building_id_or_slot" });
  }
  const state = readAndResolveKingdomState(nk, userId);
  completeFinishedUpgrades(state);
  const key = buildingKey(req.buildingId, req.slot);
  const existing = state.buildings[key];
  if (!existing) {
    return respond({ ok: false, error: "not_placed_yet" });
  }
  const currentLevel = existing.level;
  const targetLevel = currentLevel + 1;
  if (existing.upgradeFinishTick !== null) {
    return respond({ ok: false, error: "already_upgrading" });
  }
  const buildingCfg = getBuildingConfig(nk, req.buildingId);
  if (!buildingCfg) {
    return respond({ ok: false, error: "unknown_building" });
  }
  if (targetLevel > buildingCfg.max_level) {
    return respond({ ok: false, error: "max_level_reached" });
  }
  if (state.castleLevel < buildingCfg.unlock_castle_level) {
    return respond({ ok: false, error: "castle_level_too_low" });
  }
  const inProgressUpgrades = countInProgressUpgrades(state);
  const builderCapacity = getBuilderHutCapacity(nk, state);
  if (inProgressUpgrades >= builderCapacity) {
    return respond({ ok: false, error: "no_available_builder" });
  }
  if (currentLevel === 0) {
    const prereqs = getBuildingPrerequisites(nk, req.buildingId);
    for (const prereq of prereqs) {
      if (!playerHasBuildingAtLevel(state, prereq.requires_building_id, prereq.requires_level)) {
        return respond({ ok: false, error: `prerequisite_not_met:${prereq.requires_building_id}:${prereq.requires_level}` });
      }
    }
  }
  const levelCfg = getBuildingLevelConfig(nk, req.buildingId, targetLevel);
  if (!levelCfg) {
    return respond({ ok: false, error: "level_config_missing" });
  }
  if (state.resources.gold < levelCfg.cost_gold || state.resources.crystal < levelCfg.cost_crystal || state.resources.mithril < levelCfg.cost_mithril) {
    return respond({ ok: false, error: "insufficient_resources" });
  }
  state.resources.gold -= levelCfg.cost_gold;
  state.resources.crystal -= levelCfg.cost_crystal;
  state.resources.mithril -= levelCfg.cost_mithril;
  const nowSeconds = Math.floor(Date.now() / 1e3);
  existing.upgradeFinishTick = nowSeconds + levelCfg.upgrade_time_seconds;
  if (req.buildingId === "castle" && levelCfg.upgrade_time_seconds === 0) {
    state.castleLevel = targetLevel;
    existing.level = targetLevel;
    existing.upgradeFinishTick = null;
  }
  writeKingdomState(nk, userId, state);
  return respond({
    ok: true,
    building: existing,
    resources: state.resources
  });
}
function completeFinishedUpgrades(state) {
  const nowSeconds = Math.floor(Date.now() / 1e3);
  for (const key in state.buildings) {
    const b = state.buildings[key];
    if (b.upgradeFinishTick !== null && b.upgradeFinishTick <= nowSeconds) {
      b.level += 1;
      b.upgradeFinishTick = null;
      if (b.buildingId === "castle") {
        state.castleLevel = b.level;
      }
    }
  }
  return state;
}
function getBuilderHutCapacity(nk, state) {
  let capacity = 0;
  for (const key in state.buildings) {
    const b = state.buildings[key];
    if (b.buildingId !== "builder_hut" || b.level < 1) continue;
    const levelCfg = getBuildingLevelConfig(nk, "builder_hut", b.level);
    if (levelCfg && levelCfg.stat_value !== null) capacity += levelCfg.stat_value;
  }
  return capacity;
}
function countInProgressUpgrades(state) {
  let count = 0;
  for (const key in state.buildings) {
    if (state.buildings[key].upgradeFinishTick !== null) count++;
  }
  return count;
}
function playerHasBuildingAtLevel(state, buildingId, minLevel) {
  for (const key in state.buildings) {
    const b = state.buildings[key];
    if (b.buildingId === buildingId && b.level >= minLevel) return true;
  }
  return false;
}
function buildingKey(buildingId, slot) {
  return `${buildingId}:${slot}`;
}
function respond(res) {
  return JSON.stringify(res);
}

// modules/auth/hooks.ts
function afterAuthenticate(ctx, logger, nk, data) {
  const userId = ctx.userId;
  const existing = readKingdomState(nk, userId);
  if (!existing) {
    initializeNewPlayer(nk, logger, userId);
    return;
  }
  const resolved = readAndResolveKingdomState(nk, userId);
  const completed = completeFinishedUpgrades(resolved);
  writeKingdomState(nk, userId, completed);
}
function initializeNewPlayer(nk, logger, userId) {
  const shardId = getLowestPopulationOpenShard(nk);
  const startingState = {
    userId,
    shardId,
    castleLevel: 1,
    buildings: {
      "castle:2_12": { buildingId: "castle", slot: "2_12", level: 1, upgradeFinishTick: null },
      "builder_hut:2_7": { buildingId: "builder_hut", slot: "2_7", level: 1, upgradeFinishTick: null },
      "summon_hut:7_7": { buildingId: "summon_hut", slot: "7_7", level: 1, upgradeFinishTick: null },
      "gold_storage:2_2": { buildingId: "gold_storage", slot: "2_2", level: 0, upgradeFinishTick: null },
      "crystal_storage:7_2": { buildingId: "crystal_storage", slot: "7_2", level: 0, upgradeFinishTick: null },
      "mithril_storage:12_2": { buildingId: "mithril_storage", slot: "12_2", level: 0, upgradeFinishTick: null }
    },
    resources: { gold: 500, crystal: 100, mithril: 0 },
    lastCalculatedTick: Math.floor(Date.now() / 1e3),
    army: {},
    researchLevels: {},
    allianceId: null,
    displayName: `Warlord${userId.substring(0, 6)}`,
    power: 0
  };
  writeKingdomState(nk, userId, startingState);
  nk.sqlExec(
    `INSERT INTO player_shard_membership (user_id, shard_id) VALUES ($1, $2)
     ON CONFLICT DO NOTHING`,
    [userId, shardId]
  );
  logger.info("initialized new player %s on shard %d", userId, shardId);
}

// modules/economy/get_full_state.ts
function rpcGetFullState(ctx, logger, nk, payload) {
  const userId = ctx.userId;
  if (!userId) {
    return JSON.stringify({ ok: false, error: "unauthenticated" });
  }
  const resolved = readAndResolveKingdomState(nk, userId);
  const completed = completeFinishedUpgrades(resolved);
  writeKingdomState(nk, userId, completed);
  const response = {
    ok: true,
    kingdom: completed,
    army: [],
    // Volume 5 — marching armies live in their own collection
    heroes: [],
    // Volume 4 — hero roster
    alliance: completed.allianceId ? { id: completed.allianceId, stub: true } : null
  };
  return JSON.stringify(response);
}

// modules/economy/placement.ts
function rectsOverlapWithBuffer(a, b, buffer) {
  const ax1 = a.x - buffer;
  const ay1 = a.y - buffer;
  const ax2 = a.x + a.width + buffer;
  const ay2 = a.y + a.height + buffer;
  const bx1 = b.x;
  const by1 = b.y;
  const bx2 = b.x + b.width;
  const by2 = b.y + b.height;
  return ax1 < bx2 && ax2 > bx1 && ay1 < by2 && ay2 > by1;
}
function rpcPlaceBuilding(ctx, logger, nk, payload) {
  const userId = ctx.userId;
  if (!userId) return respond2({ ok: false, error: "unauthenticated" });
  let req;
  try {
    req = JSON.parse(payload);
  } catch (e) {
    return respond2({ ok: false, error: "invalid_payload" });
  }
  if (!req.buildingId || req.x === void 0 || req.y === void 0) {
    return respond2({ ok: false, error: "missing_fields" });
  }
  const state = readAndResolveKingdomState(nk, userId);
  completeFinishedUpgrades(state);
  const buildingCfg = getBuildingConfig(nk, req.buildingId);
  if (!buildingCfg) return respond2({ ok: false, error: "unknown_building" });
  const unlockCfg = getBuildingUnlockConfig(nk, req.buildingId);
  if (!unlockCfg) return respond2({ ok: false, error: "building_not_unlockable" });
  if (!unlockCfg.is_starter_building && state.castleLevel < unlockCfg.unlock_castle_level) {
    return respond2({ ok: false, error: "not_yet_unlocked" });
  }
  const gridWidth = getWorldConfigValue(nk, "city_grid_width");
  const gridHeight = getWorldConfigValue(nk, "city_grid_height");
  const newRect = { x: req.x, y: req.y, width: buildingCfg.footprint_width, height: buildingCfg.footprint_height };
  if (newRect.x < 0 || newRect.y < 0 || newRect.x + newRect.width > gridWidth || newRect.y + newRect.height > gridHeight) {
    return respond2({ ok: false, error: "out_of_bounds" });
  }
  const buffer = getWorldConfigValue(nk, "placement_buffer_tiles");
  for (const key2 in state.buildings) {
    const existing = state.buildings[key2];
    const existingCfg = getBuildingConfig(nk, existing.buildingId);
    if (!existingCfg) continue;
    const parts = existing.slot.split("_").map(Number);
    const existingRect = { x: parts[0], y: parts[1], width: existingCfg.footprint_width, height: existingCfg.footprint_height };
    if (rectsOverlapWithBuffer(newRect, existingRect, buffer)) {
      return respond2({ ok: false, error: "overlaps_or_too_close", conflictingSlot: existing.slot });
    }
  }
  const slotKey = `${req.x}_${req.y}`;
  const key = `${req.buildingId}:${slotKey}`;
  if (state.buildings[key]) {
    return respond2({ ok: false, error: "already_placed_here" });
  }
  state.buildings[key] = {
    buildingId: req.buildingId,
    slot: slotKey,
    level: 0,
    // placed but not yet built — upgrade_building takes it to level 1
    upgradeFinishTick: null
  };
  writeKingdomState(nk, userId, state);
  return respond2({ ok: true, building: state.buildings[key] });
}
function respond2(res) {
  return JSON.stringify(res);
}

// modules/main.ts
var InitModule = function(ctx, logger, nk, initializer) {
  initializer.registerAfterAuthenticateDevice(afterAuthenticate);
  initializer.registerAfterAuthenticateEmail(afterAuthenticate);
  initializer.registerAfterAuthenticateGoogle(afterAuthenticate);
  initializer.registerAfterAuthenticateApple(afterAuthenticate);
  initializer.registerRpc("get_full_state", rpcGetFullState);
  initializer.registerRpc("upgrade_building", rpcUpgradeBuilding);
  initializer.registerRpc("place_building", rpcPlaceBuilding);
  logger.info("Storm MMORTS Volume 1 modules loaded");
};
globalThis.InitModule = InitModule;
