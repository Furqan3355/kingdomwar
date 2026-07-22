// modules/army/hospital.ts
// Volume 5 §5, REDESIGNED per user's explicit request: Hospital now works
// exactly like Training (army/training.ts) instead of a passive %-per-hour
// heal:
//   - Hospital has heal QUEUE SLOTS (building_level_config.secondary_stat_value,
//     same convention as Barracks' stat_value = training slots — see 0009_hospital_queue.sql)
//   - Each unit type has its OWN heal_time_seconds and heal_cost_* (cheaper
//     & faster than training the same unit from scratch — unit_config columns
//     added in 0009_hospital_queue.sql)
//   - Starting a heal consumes resources up front and reserves a queue slot,
//     same as starting a training order
//   - Troop only returns to `army` when its HealOrder finishes — it does NOT
//     stay available in `woundedTroops` while being healed (reserved, same
//     as training consumes resources before the unit exists)
//
// Wounding (moving losses from garrison -> woundedTroops) still happens in
// Volume 6's combat resolver, defensive losses only — troops lost while
// attacking never reach Hospital (unchanged, §3.1 of the original doc).

import { KingdomState } from '../types';
import { getBuildingLevelConfig, getUnitConfig } from '../config/loader';
import { readAndResolveKingdomState, writeKingdomState } from '../economy/resources';
import { HealOrder, HOSPITAL_COLLECTION } from './types';

export function getActiveHealOrders(nk: nkruntime.Nakama, userId: string): HealOrder[] {
  const result = nk.storageList(userId, HOSPITAL_COLLECTION, 100);
  const objects = (result && result.objects) || [];
  return objects
    .map((o) => o.value as HealOrder)
    .filter((o) => o.status === 'healing');
}

function writeHealOrder(nk: nkruntime.Nakama, userId: string, order: HealOrder): void {
  nk.storageWrite([
    {
      collection: HOSPITAL_COLLECTION,
      key: order.orderId,
      userId,
      value: order,
      permissionRead: 1,
      permissionWrite: 0,
    },
  ]);
}

function deleteHealOrder(nk: nkruntime.Nakama, userId: string, orderId: string): void {
  nk.storageDelete([{ collection: HOSPITAL_COLLECTION, key: orderId, userId }]);
}

function hasSummonHut(state: KingdomState): boolean {
  for (const key in state.buildings) {
    if (state.buildings[key].buildingId === 'summon_hut') return true;
  }
  return false;
}

// Capacity/queue-slots for ONE SPECIFIC Hospital building (identified by its
// slot, e.g. '12_12') — per user's design call, same per-building tracking
// as Barracks/training, not a shared pool across every Hospital owned.
function getHospitalStatsForSlot(
  nk: nkruntime.Nakama,
  state: KingdomState,
  buildingSlot: string
): { capacity: number; queueSlots: number } | null {
  const b = state.buildings[`hospital:${buildingSlot}`];
  if (!b || b.level < 1) return null; // null = no such Hospital at that slot / not built yet
  const levelCfg = getBuildingLevelConfig(nk, 'hospital', b.level);
  if (!levelCfg) return { capacity: 0, queueSlots: 0 };
  return {
    capacity: levelCfg.stat_value !== null ? levelCfg.stat_value : 0,
    queueSlots: levelCfg.secondary_stat_value !== null ? levelCfg.secondary_stat_value : 0,
  };
}

// Capacity summed across ALL Hospitals — still used for the wound-overflow
// check in woundTroops(), since a wounded troop can land in any Hospital's
// shared capacity pool (only the QUEUE/heal-order side is per-building).
function getTotalHospitalCapacity(nk: nkruntime.Nakama, state: KingdomState): number {
  let capacity = 0;
  for (const key in state.buildings) {
    const b = state.buildings[key];
    if (b.buildingId !== 'hospital' || b.level < 1) continue;
    const levelCfg = getBuildingLevelConfig(nk, 'hospital', b.level);
    if (levelCfg && levelCfg.stat_value !== null) capacity += levelCfg.stat_value;
  }
  return capacity;
}

export function rpcHealTroops(
  ctx: nkruntime.Context,
  logger: nkruntime.Logger,
  nk: nkruntime.Nakama,
  payload: string
): string {
  const userId = ctx.userId;
  if (!userId) return respond({ ok: false, error: 'unauthenticated' });

  let req: { unitId: string; quantity: number; buildingSlot: string };
  try {
    req = JSON.parse(payload);
  } catch (e) {
    return respond({ ok: false, error: 'invalid_payload' });
  }
  if (!req.unitId || !req.quantity || req.quantity <= 0 || !req.buildingSlot) {
    return respond({ ok: false, error: 'missing_unit_id_quantity_or_building_slot' });
  }

  // Caller (get_full_state / any army RPC) is expected to have already run
  // completeFinishedHealOrders on this state before this RPC is invoked, same
  // as training — but resolve again here defensively since this can also be
  // called standalone.
  const state: KingdomState = readAndResolveKingdomState(nk, userId);
  completeFinishedHealOrders(nk, userId, state);

  // Summon Hut is a hard gate for healing too (per user's confirmed design).
  if (!hasSummonHut(state)) {
    return respond({ ok: false, error: 'summon_hut_required' });
  }

  const woundedAvailable = state.hospital.woundedTroops[req.unitId] || 0;
  if (woundedAvailable < req.quantity) {
    return respond({ ok: false, error: 'insufficient_wounded' });
  }

  const hospitalStats = getHospitalStatsForSlot(nk, state, req.buildingSlot);
  if (hospitalStats === null) {
    return respond({ ok: false, error: 'no_such_hospital_at_slot' });
  }

  // Per-building queue check: only orders already sitting against THIS
  // specific Hospital count against its slot cap.
  const activeOrders = getActiveHealOrders(nk, userId).filter((o) => o.buildingSlot === req.buildingSlot);
  if (activeOrders.length >= hospitalStats.queueSlots) {
    return respond({ ok: false, error: 'heal_queue_full' });
  }

  const unitCfg = getUnitConfig(nk, req.unitId);
  if (!unitCfg) return respond({ ok: false, error: 'unknown_unit' });

  const totalCost = {
    gold: unitCfg.heal_cost_gold * req.quantity,
    crystal: unitCfg.heal_cost_crystal * req.quantity,
    mithril: unitCfg.heal_cost_mithril * req.quantity,
  };
  if (
    state.resources.gold < totalCost.gold ||
    state.resources.crystal < totalCost.crystal ||
    state.resources.mithril < totalCost.mithril
  ) {
    return respond({ ok: false, error: 'insufficient_resources' });
  }

  // Reserve: pull the troops out of woundedTroops and spend resources now —
  // mirrors training spending resources before the unit exists. The troop
  // is "in the hospital bed", not simultaneously re-queueable from wounded.
  state.hospital.woundedTroops[req.unitId] = woundedAvailable - req.quantity;
  state.resources.gold -= totalCost.gold;
  state.resources.crystal -= totalCost.crystal;
  state.resources.mithril -= totalCost.mithril;
  writeKingdomState(nk, userId, state);

  const nowSeconds = Math.floor(Date.now() / 1000);
  const order: HealOrder = {
    orderId: nk.uuidv4(),
    buildingSlot: req.buildingSlot,
    unitId: req.unitId,
    quantity: req.quantity,
    perUnitSeconds: unitCfg.heal_time_seconds,
    creditedQuantity: 0,
    startTick: nowSeconds,
    finishTick: nowSeconds + unitCfg.heal_time_seconds * req.quantity,
    status: 'healing',
  };
  writeHealOrder(nk, userId, order);

  return respond({ ok: true, order, resources: state.resources, hospital: state.hospital });
}

// Lazy-resolved from get_full_state and any army-touching RPC, identical
// philosophy to completeFinishedTrainingOrders — client never polls "is
// healing done yet". TRICKLE, not all-at-once, same as training: each
// healed unit returns to `army` as its own heal_time_seconds elapses.
export function completeFinishedHealOrders(
  nk: nkruntime.Nakama,
  userId: string,
  state: KingdomState
): KingdomState {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const orders = getActiveHealOrders(nk, userId);
  for (const order of orders) {
    const elapsed = Math.max(0, nowSeconds - order.startTick);
    const unitsElapsed = Math.min(order.quantity, Math.floor(elapsed / order.perUnitSeconds));
    const newlyCredited = unitsElapsed - order.creditedQuantity;
    if (newlyCredited > 0) {
      state.army[order.unitId] = (state.army[order.unitId] || 0) + newlyCredited;
      order.creditedQuantity = unitsElapsed;
    }
    if (order.creditedQuantity >= order.quantity) {
      deleteHealOrder(nk, userId, order.orderId);
    } else if (newlyCredited > 0) {
      writeHealOrder(nk, userId, order); // persist partial progress so it isn't re-credited next read
    }
  }
  return state;
}

// Adds troops to the wounded pool, clamped to Hospital capacity — anything
// beyond capacity is lost permanently (capacity-overflow = permanent death,
// per §3.1). Exported for Volume 6's combat resolver to call on defensive
// losses; not called anywhere in Volume 5 itself since combat doesn't exist
// yet. Capacity check counts troops sitting in woundedTroops only — troops
// already pulled into an active HealOrder are no longer "in" wounded, so
// they correctly don't count against capacity twice.
export function woundTroops(nk: nkruntime.Nakama, state: KingdomState, losses: Record<string, number>): void {
  const capacity = getTotalHospitalCapacity(nk, state);
  let currentWounded = 0;
  for (const unitId in state.hospital.woundedTroops) currentWounded += state.hospital.woundedTroops[unitId];

  for (const unitId in losses) {
    const loss = losses[unitId];
    if (!loss || loss <= 0) continue;
    const spaceLeft = Math.max(0, capacity - currentWounded);
    const toHospital = Math.min(loss, spaceLeft);
    if (toHospital > 0) {
      state.hospital.woundedTroops[unitId] = (state.hospital.woundedTroops[unitId] || 0) + toHospital;
      currentWounded += toHospital;
    }
    // toHospital < loss => the remainder is permanently killed (capacity overflow)
  }
}

function respond(res: any): string {
  return JSON.stringify(res);
}
