// modules/economy/resources.ts
import { KingdomState, KINGDOM_COLLECTION, KINGDOM_KEY } from '../types';
import { getBuildingLevelConfig, getBuildingConfig, getStorageCapForResource } from '../config/loader';
import { migrateState } from './migrations';

// Implements the lazy-resolve production pattern from Volume 1 §5/§7.1:
// resources are computed from (stored + rate * elapsed) on every read,
// never via a per-player scheduled tick.

export function readKingdomState(nk: nkruntime.Nakama, userId: string): KingdomState | null {
  const objects = nk.storageRead([
    { collection: KINGDOM_COLLECTION, key: KINGDOM_KEY, userId },
  ]);
  if (!objects || objects.length === 0) {
    return null;
  }
  // Apply pending migrations before this state is used anywhere — otherwise
  // states saved under an older shape (e.g. missing stateVersion) flow into
  // RPCs like upgrade_building with fields the current code assumes exist.
  return migrateState(objects[0].value as KingdomState);
}

// Applies lazy production resolve in-memory. Does NOT write back — callers
// decide when to persist (see readAndResolveKingdomState below).
//
// NOTE on scale: this queries building_config/building_level_config once per
// building on every resolve. Fine at this project's scale (a handful of
// buildings per player). If profiling later shows this as a hot path, cache
// {buildingId, level} -> config in a small in-process LRU inside this module
// — do not change the KingdomState shape to smuggle a rate cache into player
// storage, since that reintroduces a second source of truth for a value
// config already owns (Volume 1 §9.2 rule).
export function resolveProductionInMemory(nk: nkruntime.Nakama, state: KingdomState): KingdomState {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const elapsed = Math.max(0, nowSeconds - state.lastCalculatedTick);
  if (elapsed === 0) {
    return state;
  }

  let goldRate = 0;
  let crystalRate = 0;
  let mithrilRate = 0;

  for (const key in state.buildings) {
    const b = state.buildings[key];
    if (b.upgradeFinishTick !== null) continue; // still under construction — no production yet
    const buildingCfg = getBuildingConfig(nk, b.buildingId);
    // Checks resource_type presence rather than effect_type === 'production'
    // — some buildings are dual-purpose (e.g. Castle is effect_type:
    // 'utility' for the unlock-gate role, but ALSO has resource_type: 'gold'
    // since the city itself produces gold directly, per the 0004 redesign).
    // A building only needs a resource_type + a production_rate at its
    // current level to contribute — its primary effect_type category
    // doesn't gate this.
    if (!buildingCfg || !buildingCfg.resource_type) continue;

    const levelCfg = getBuildingLevelConfig(nk, b.buildingId, b.level);
    if (!levelCfg || levelCfg.production_rate === null) continue;

    // Volume 2 §2.3: resource_type is now a real config column, not inferred
    // from the buildingId string — this replaces Volume 1's naming-convention
    // placeholder.
    if (buildingCfg.resource_type === 'gold') goldRate += levelCfg.production_rate;
    else if (buildingCfg.resource_type === 'crystal') crystalRate += levelCfg.production_rate;
    else if (buildingCfg.resource_type === 'mithril') mithrilRate += levelCfg.production_rate;
  }

  const goldCap = getStorageCapForResource(nk, state.buildings, 'gold');
  const crystalCap = getStorageCapForResource(nk, state.buildings, 'crystal');
  const mithrilCap = getStorageCapForResource(nk, state.buildings, 'mithril');

  // Volume 2 §4: production is clamped to current storage cap — building a
  // Storage building raises this ceiling, it doesn't add a growth rate.
  state.resources.gold = clamp(state.resources.gold + elapsed * goldRate, goldCap);
  state.resources.crystal = clamp(state.resources.crystal + elapsed * crystalRate, crystalCap);
  state.resources.mithril = clamp(state.resources.mithril + elapsed * mithrilRate, mithrilCap);
  state.lastCalculatedTick = nowSeconds;
  return state;
}

function clamp(value: number, cap: number): number {
  // cap of 0 means "no storage building built yet" — don't accidentally
  // zero-clamp a new player's starting resources (Volume 1 seeds 500 gold /
  // 100 crystal with no storage building owned yet).
  if (cap <= 0) return value;
  return Math.min(value, cap);
}

export function writeKingdomState(
  nk: nkruntime.Nakama,
  userId: string,
  state: KingdomState,
  version?: string
): void {
  const write: nkruntime.StorageWriteRequest = {
    collection: KINGDOM_COLLECTION,
    key: KINGDOM_KEY,
    userId,
    value: state,
    permissionRead: 1,   // owner read only
    permissionWrite: 0,  // no direct client writes — server only, per §2.1
  };
  if (version) {
    write.version = version; // optimistic concurrency, see rule §17 (read-validate-write)
  }
  nk.storageWrite([write]);
}

// Convenience used by RPCs that just need up-to-date resources without
// necessarily persisting immediately (e.g. get_full_state reads-and-flushes
// in one step so the client never sees stale numbers).
export function readAndResolveKingdomState(
  nk: nkruntime.Nakama,
  userId: string
): KingdomState {
  const state = readKingdomState(nk, userId);
  if (!state) {
    throw Error(`kingdom state not found for user ${userId} — afterAuthenticate hook should have created it`);
  }
  const resolved = resolveProductionInMemory(nk, state);
  writeKingdomState(nk, userId, resolved);
  return resolved;
}