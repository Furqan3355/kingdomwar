// modules/economy/buildings.ts
import {
  KingdomState,
  UpgradeBuildingRequest,
  UpgradeBuildingResponse,
} from '../types';
import { getBuildingConfig, getBuildingLevelConfig, getBuildingPrerequisites } from '../config/loader';
import { readAndResolveKingdomState, writeKingdomState } from './resources';

// Generic building-upgrade RPC. As of 0005 (freeform placement), a building
// must already exist on the grid — via place_building (placement.ts) — before
// it can be upgraded. This RPC no longer creates instances out of thin air;
// it only ever advances an EXISTING instance from its current level to +1.

const RESEARCH_MAX_CONCURRENT = 1; // fixed rule, not a per-Builder-Hut-scaled value — see §Builder Hut note below

export function rpcUpgradeBuilding(
  ctx: nkruntime.Context,
  logger: nkruntime.Logger,
  nk: nkruntime.Nakama,
  payload: string
): string {
  const userId = ctx.userId;
  if (!userId) {
    return respond({ ok: false, error: 'unauthenticated' });
  }

  let req: UpgradeBuildingRequest;
  try {
    req = JSON.parse(payload);
  } catch (e) {
    return respond({ ok: false, error: 'invalid_payload' });
  }
  if (!req.buildingId || !req.slot) {
    return respond({ ok: false, error: 'missing_building_id_or_slot' });
  }

  // Rule §17: always resolve current authoritative state before validating.
  const state = readAndResolveKingdomState(nk, userId);
  
  completeFinishedUpgrades(state);
  const key = buildingKey(req.buildingId, req.slot);
  const existing = state.buildings[key];
  logger.info("UserId: %s", userId);
logger.info("Buildings: %s", JSON.stringify(state.buildings));


logger.info("Lookup key: %s", key);
logger.info("Found: %s", state.buildings[key] ? "YES" : "NO");

  // 0005: buildings must be placed (place_building) before they can be
  // upgraded — this RPC never creates a new instance implicitly anymore.
  if (!existing) {
    return respond({ ok: false, error: 'not_placed_yet' });
  }

  const currentLevel = existing.level;
  const targetLevel = currentLevel + 1;

  // Reject if already upgrading (idempotency guard, rule §18).
  if (existing.upgradeFinishTick !== null) {
    return respond({ ok: false, error: 'already_upgrading' });
  }

  const buildingCfg = getBuildingConfig(nk, req.buildingId);
  if (!buildingCfg) {
    return respond({ ok: false, error: 'unknown_building' });
  }
  if (targetLevel > buildingCfg.max_level) {
    return respond({ ok: false, error: 'max_level_reached' });
  }
  if (state.castleLevel < buildingCfg.unlock_castle_level) {
    return respond({ ok: false, error: 'castle_level_too_low' });
  }

  // Builder Hut concurrency check (new in 0005): the number of buildings
  // simultaneously mid-upgrade cannot exceed the sum of stat_value across
  // all built (level >= 1) Builder Huts. Research is a SEPARATE pool always
  // capped at RESEARCH_MAX_CONCURRENT regardless of Builder Hut count — but
  // research itself isn't implemented via this RPC yet (Academy is still a
  // shell, per Volume 2 §10), so only the building-upgrade pool is enforced
  // here. When research lands, it must check its OWN concurrent-count
  // against RESEARCH_MAX_CONCURRENT, not against Builder Hut capacity.
  const inProgressUpgrades = countInProgressUpgrades(state);
  const builderCapacity = getBuilderHutCapacity(nk, state);
  if (inProgressUpgrades >= builderCapacity) {
    return respond({ ok: false, error: 'no_available_builder' });
  }

  // Volume 2 §12.2: cross-building prerequisites (e.g. Academy needs
  // Barracks at a minimum level first). Only checked on first construction
  // (currentLevel === 0) — once built, later upgrades don't re-check this.
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
    return respond({ ok: false, error: 'level_config_missing' });
  }

  // Re-validate cost server-side against Postgres config — never trust a
  // client-submitted cost (rule §17).
  if (
    state.resources.gold < levelCfg.cost_gold ||
    state.resources.crystal < levelCfg.cost_crystal ||
    state.resources.mithril < levelCfg.cost_mithril
  ) {
    return respond({ ok: false, error: 'insufficient_resources' });
  }

  state.resources.gold -= levelCfg.cost_gold;
  state.resources.crystal -= levelCfg.cost_crystal;
  state.resources.mithril -= levelCfg.cost_mithril;

  const nowSeconds = Math.floor(Date.now() / 1000);
  existing.upgradeFinishTick = nowSeconds + levelCfg.upgrade_time_seconds;

  // Volume 2 §15: Castle is the one building-ID-specific branch in this
  // otherwise-generic RPC, since KingdomState.castleLevel is a top-level
  // field gating every other building's unlock_castle_level.
  if (req.buildingId === 'castle' && levelCfg.upgrade_time_seconds === 0) {
    // Zero-time upgrades (e.g. the free starting level 1) complete instantly.
    state.castleLevel = targetLevel;
    existing.level = targetLevel;
    existing.upgradeFinishTick = null;
  }

  writeKingdomState(nk, userId, state);

  return respond({
    ok: true,
    building: existing,
    resources: state.resources,
  });
}

// Called from get_full_state (and any building-touching RPC) before reading
// state back out, so a client never has to separately poll "is it done yet."
export function completeFinishedUpgrades(state: KingdomState): KingdomState {
  const nowSeconds = Math.floor(Date.now() / 1000);
  for (const key in state.buildings) {
    const b = state.buildings[key];
    if (b.upgradeFinishTick !== null && b.upgradeFinishTick <= nowSeconds) {
      b.level += 1;
      b.upgradeFinishTick = null;
      if (b.buildingId === 'castle') {
        state.castleLevel = b.level; // Volume 2 §15 — kept in sync on completion too
      }
    }
  }
  return state;
}

// 0005: sum of stat_value across every built (level >= 1) Builder Hut —
// this is the player's total concurrent building-upgrade capacity.
function getBuilderHutCapacity(nk: nkruntime.Nakama, state: KingdomState): number {
  let capacity = 0;
  for (const key in state.buildings) {
    const b = state.buildings[key];
    if (b.buildingId !== 'builder_hut' || b.level < 1) continue;
    const levelCfg = getBuildingLevelConfig(nk, 'builder_hut', b.level);
    if (levelCfg && levelCfg.stat_value !== null) capacity += levelCfg.stat_value;
  }
  return capacity;
}

function countInProgressUpgrades(state: KingdomState): number {
  let count = 0;
  for (const key in state.buildings) {
    if (state.buildings[key].upgradeFinishTick !== null) count++;
  }
  return count;
}

function playerHasBuildingAtLevel(state: KingdomState, buildingId: string, minLevel: number): boolean {
  for (const key in state.buildings) {
    const b = state.buildings[key];
    if (b.buildingId === buildingId && b.level >= minLevel) return true;
  }
  return false;
}

function buildingKey(buildingId: string, slot: string): string {
  return `${buildingId}:${slot}`;
}

function respond(res: UpgradeBuildingResponse): string {
  return JSON.stringify(res);
}
