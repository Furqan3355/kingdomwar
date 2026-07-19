// modules/economy/buildings.ts
import {
  KingdomState,
  UpgradeBuildingRequest,
  UpgradeBuildingResponse,
} from '../types';
import { getBuildingConfig, getBuildingLevelConfig, getBuildingPrerequisites, getSlotBinding } from '../config/loader';
import { readAndResolveKingdomState, writeKingdomState } from './resources';

// Generic building-upgrade RPC. Handles ANY building defined in
// building_config/building_level_config. Volume 2 layers slot-binding,
// cross-building prerequisites, and the Castle-level sync branch on top of
// the Volume 1 framework below.

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

  // Volume 2 §12.3: reject placing a building at a slot it's not bound to
  // (e.g. can't put gold_factory where castle belongs).
  const slotBinding = getSlotBinding(nk, req.slot);
  if (!slotBinding || slotBinding.building_id !== req.buildingId) {
    return respond({ ok: false, error: 'invalid_slot_for_building' });
  }

  // Rule §17: always resolve current authoritative state before validating.
  const state = readAndResolveKingdomState(nk, userId);
  completeFinishedUpgrades(state);
  const key = buildingKey(req.buildingId, req.slot);
  const existing = state.buildings[key];
  const currentLevel = existing ? existing.level : 0;
  const targetLevel = currentLevel + 1;

  // Reject if already upgrading (idempotency guard, rule §18).
  if (existing && existing.upgradeFinishTick !== null) {
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

  // Volume 2 §12.2: cross-building prerequisites (e.g. Academy needs
  // Barracks at a minimum level first). Only checked on first construction
  // (currentLevel === 0) — once built, later upgrades don't re-check this,
  // matching how the reference genre treats prerequisites as a one-time gate.
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
  const newInstance = {
    buildingId: req.buildingId,
    slot: req.slot,
    level: currentLevel, // level only increments on completion, see completeFinishedUpgrades()
    upgradeFinishTick: nowSeconds + levelCfg.upgrade_time_seconds,
  };
  state.buildings[key] = newInstance;

  // Volume 2 §15: Castle is the one building-ID-specific branch in this
  // otherwise-generic RPC, since KingdomState.castleLevel is a top-level
  // field gating every other building's unlock_castle_level. Synced here at
  // request time so an in-progress Castle upgrade's target level is visible
  // immediately; completion-time sync happens in completeFinishedUpgrades().
  if (req.buildingId === 'castle' && levelCfg.upgrade_time_seconds === 0) {
    // Zero-time upgrades (e.g. the free starting level 1) complete instantly
    // — sync castleLevel right away rather than waiting for a later read.
    state.castleLevel = targetLevel;
    newInstance.level = targetLevel;
    newInstance.upgradeFinishTick = null;
  }

  writeKingdomState(nk, userId, state);

  return respond({
    ok: true,
    building: newInstance,
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
