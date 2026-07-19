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
           resource_type, effect_type
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
    effect_type: row.effect_type
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
function getSlotBinding(nk, slotId) {
  const query = `SELECT slot_id, building_id FROM building_slot WHERE slot_id = $1`;
  const result = nk.sqlQuery(query, [slotId]);
  if (!result || result.length === 0) return null;
  return { slot_id: result[0].slot_id, building_id: result[0].building_id };
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
    if (!buildingCfg || buildingCfg.effect_type !== "production") continue;
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
  const slotBinding = getSlotBinding(nk, req.slot);
  if (!slotBinding || slotBinding.building_id !== req.buildingId) {
    return respond({ ok: false, error: "invalid_slot_for_building" });
  }
  const state = readAndResolveKingdomState(nk, userId);
  completeFinishedUpgrades(state);
  const key = buildingKey(req.buildingId, req.slot);
  const existing = state.buildings[key];
  const currentLevel = existing ? existing.level : 0;
  const targetLevel = currentLevel + 1;
  if (existing && existing.upgradeFinishTick !== null) {
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
  const newInstance = {
    buildingId: req.buildingId,
    slot: req.slot,
    level: currentLevel,
    // level only increments on completion, see completeFinishedUpgrades()
    upgradeFinishTick: nowSeconds + levelCfg.upgrade_time_seconds
  };
  state.buildings[key] = newInstance;
  if (req.buildingId === "castle" && levelCfg.upgrade_time_seconds === 0) {
    state.castleLevel = targetLevel;
    newInstance.level = targetLevel;
    newInstance.upgradeFinishTick = null;
  }
  writeKingdomState(nk, userId, state);
  return respond({
    ok: true,
    building: newInstance,
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
    // Volume 2 §9: the Castle building instance and castleLevel must start
    // in sync — 0002_city_system.sql seeds castle level 1 as free/instant, so
    // the new player begins already "built" at level 1, not mid-construction.
    buildings: {
      "castle:4_4": {
        buildingId: "castle",
        slot: "4_4",
        level: 1,
        upgradeFinishTick: null
      }
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

// modules/main.ts
var InitModule = function(ctx, logger, nk, initializer) {
  initializer.registerAfterAuthenticateDevice(afterAuthenticate);
  initializer.registerAfterAuthenticateEmail(afterAuthenticate);
  initializer.registerAfterAuthenticateGoogle(afterAuthenticate);
  initializer.registerAfterAuthenticateApple(afterAuthenticate);
  initializer.registerRpc("get_full_state", rpcGetFullState);
  initializer.registerRpc("upgrade_building", rpcUpgradeBuilding);
  logger.info("Storm MMORTS Volume 1 modules loaded");
};
globalThis.InitModule = InitModule;
