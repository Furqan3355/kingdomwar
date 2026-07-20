// modules/economy/placement.ts
import { KingdomState, PlaceBuildingRequest } from '../types';
import { getBuildingConfig, getBuildingUnlockConfig, getWorldConfigValue } from '../config/loader';
import { readAndResolveKingdomState, writeKingdomState } from './resources';
import { completeFinishedUpgrades } from './buildings';

// Placement is FREE and separate from upgrading (0005 redesign) — placing a
// building just claims grid space and creates a level-0 instance; the
// player then calls upgrade_building separately to actually construct it
// to level 1 (which is where cost/timer/Builder-Hut-concurrency apply).

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

function rectsOverlapWithBuffer(a: Rect, b: Rect, buffer: number): boolean {
  // Inflate 'a' by the buffer on all sides, then do a standard AABB overlap
  // check against 'b'. This enforces the minimum gap between ANY two
  // buildings, not just literal tile overlap — matches the Clash-of-Clans-
  // style buffer-zone requirement.
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

export function rpcPlaceBuilding(
  ctx: nkruntime.Context,
  logger: nkruntime.Logger,
  nk: nkruntime.Nakama,
  payload: string
): string {
  const userId = ctx.userId;
  if (!userId) return respond({ ok: false, error: 'unauthenticated' });

  let req: PlaceBuildingRequest;
  try {
    req = JSON.parse(payload);
  } catch (e) {
    return respond({ ok: false, error: 'invalid_payload' });
  }
  if (!req.buildingId || req.x === undefined || req.y === undefined) {
    return respond({ ok: false, error: 'missing_fields' });
  }

  const state = readAndResolveKingdomState(nk, userId);
  completeFinishedUpgrades(state);

  const buildingCfg = getBuildingConfig(nk, req.buildingId);
  if (!buildingCfg) return respond({ ok: false, error: 'unknown_building' });

  // Ownership/unlock check — the "shop" concept (0005 §3). A building must
  // be unlocked (starter, or castle level reached) before it can be placed
  // at all — this is separate from and prior to any cost/timer check, which
  // only happens later at upgrade_building time.
  const unlockCfg = getBuildingUnlockConfig(nk, req.buildingId);
  if (!unlockCfg) return respond({ ok: false, error: 'building_not_unlockable' });
  if (!unlockCfg.is_starter_building && state.castleLevel < unlockCfg.unlock_castle_level) {
    return respond({ ok: false, error: 'not_yet_unlocked' });
  }

  // Grid bounds check
  const gridWidth = getWorldConfigValue(nk, 'city_grid_width');
  const gridHeight = getWorldConfigValue(nk, 'city_grid_height');
  const newRect: Rect = { x: req.x, y: req.y, width: buildingCfg.footprint_width, height: buildingCfg.footprint_height };
  if (newRect.x < 0 || newRect.y < 0 || newRect.x + newRect.width > gridWidth || newRect.y + newRect.height > gridHeight) {
    return respond({ ok: false, error: 'out_of_bounds' });
  }

  // Overlap + buffer-zone check against every existing building
  const buffer = getWorldConfigValue(nk, 'placement_buffer_tiles');
  for (const key in state.buildings) {
    const existing = state.buildings[key];
    const existingCfg = getBuildingConfig(nk, existing.buildingId);
    if (!existingCfg) continue;
    const parts = existing.slot.split('_').map(Number);
    const existingRect: Rect = { x: parts[0], y: parts[1], width: existingCfg.footprint_width, height: existingCfg.footprint_height };
    if (rectsOverlapWithBuffer(newRect, existingRect, buffer)) {
      return respond({ ok: false, error: 'overlaps_or_too_close', conflictingSlot: existing.slot });
    }
  }

  const slotKey = `${req.x}_${req.y}`;
  const key = `${req.buildingId}:${slotKey}`;
  if (state.buildings[key]) {
    return respond({ ok: false, error: 'already_placed_here' });
  }

  state.buildings[key] = {
    buildingId: req.buildingId,
    slot: slotKey,
    level: 0,               // placed but not yet built — upgrade_building takes it to level 1
    upgradeFinishTick: null,
  };

  writeKingdomState(nk, userId, state);
  return respond({ ok: true, building: state.buildings[key] });
}

function respond(res: object): string {
  return JSON.stringify(res);
}
