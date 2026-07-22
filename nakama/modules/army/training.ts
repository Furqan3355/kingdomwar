// modules/army/training.ts
// Volume 5 §2 (training queue), rebuilt against the custom unit roster.
// Barracks stat_value still means "queue slot count PER BARRACKS building"
// (per user's explicit design call — training is now PER-BUILDING, not a
// shared pool across all Barracks a player owns). If a player has two
// Barracks, each has its own independent queue capacity; an order started
// against one Barracks does not compete with orders on the other.

import { KingdomState } from '../types';
import { getUnitConfig, getUnitUnlockConfig, getBuildingLevelConfig } from '../config/loader';
import { readAndResolveKingdomState, writeKingdomState } from '../economy/resources';
import { TrainingOrder, TRAINING_COLLECTION } from './types';
import { computeSlotsUsed } from './formation';

const ARMY_CAP_PER_BARRACKS_LEVEL = 200; // design constant, tune later — barracks-level-driven army cap

export function getActiveTrainingOrders(nk: nkruntime.Nakama, userId: string): TrainingOrder[] {
  const result = nk.storageList(userId, TRAINING_COLLECTION, 100);
  const objects = (result && result.objects) || [];
  return objects
    .map((o) => o.value as TrainingOrder)
    .filter((o) => o.status === 'training');
}

function writeTrainingOrder(nk: nkruntime.Nakama, userId: string, order: TrainingOrder): void {
  nk.storageWrite([
    {
      collection: TRAINING_COLLECTION,
      key: order.orderId,
      userId,
      value: order,
      permissionRead: 1,
      permissionWrite: 0,
    },
  ]);
}

function deleteTrainingOrder(nk: nkruntime.Nakama, userId: string, orderId: string): void {
  nk.storageDelete([{ collection: TRAINING_COLLECTION, key: orderId, userId }]);
}

// Slot count for ONE SPECIFIC Barracks building (identified by its slot,
// e.g. '10_10'), not summed across every Barracks the player owns.
function getBarracksSlotCountForSlot(nk: nkruntime.Nakama, state: KingdomState, buildingSlot: string): number | null {
  const b = state.buildings[`barracks:${buildingSlot}`];
  if (!b || b.level < 1) return null; // null = no such Barracks at that slot / not built yet
  const levelCfg = getBuildingLevelConfig(nk, 'barracks', b.level);
  const slots = levelCfg && levelCfg.stat_value !== null ? levelCfg.stat_value : 1;
  return Math.max(1, slots);
}

function hasSummonHut(state: KingdomState): boolean {
  for (const key in state.buildings) {
    if (state.buildings[key].buildingId === 'summon_hut') return true;
  }
  return false;
}

function getArmyCap(nk: nkruntime.Nakama, state: KingdomState): number {
  let cap = 0;
  for (const key in state.buildings) {
    const b = state.buildings[key];
    if (b.buildingId !== 'barracks' || b.level < 1) continue;
    cap += b.level * ARMY_CAP_PER_BARRACKS_LEVEL;
  }
  return cap;
}

export function rpcTrainTroops(
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

  const state = readAndResolveKingdomState(nk, userId);
  completeFinishedTrainingOrders(nk, userId, state);

  // Summon Hut is a hard gate for training (per user's confirmed design —
  // required for summoning, not just a stat source).
  if (!hasSummonHut(state)) {
    return respond({ ok: false, error: 'summon_hut_required' });
  }

  const barracksSlots = getBarracksSlotCountForSlot(nk, state, req.buildingSlot);
  if (barracksSlots === null) {
    return respond({ ok: false, error: 'no_such_barracks_at_slot' });
  }

  // Per-building queue check: only orders already sitting against THIS
  // specific Barracks count against its slot cap. A second Barracks
  // elsewhere is a completely independent queue.
  const activeOrders = getActiveTrainingOrders(nk, userId).filter((o) => o.buildingSlot === req.buildingSlot);
  if (activeOrders.length >= barracksSlots) {
    return respond({ ok: false, error: 'queue_full' });
  }

  const unitCfg = getUnitConfig(nk, req.unitId);
  if (!unitCfg) return respond({ ok: false, error: 'unknown_unit' });

  const unlock = getUnitUnlockConfig(nk, req.unitId);
  if (unlock && state.castleLevel < unlock.unlock_castle_level) {
    return respond({ ok: false, error: 'castle_level_too_low' });
  }

  // Elite-slot-aware army cap check (§ Elite = 3 slots rule) — army cap
  // itself is still a whole-account total across ALL Barracks (that part
  // is unchanged), so this counts orders from every Barracks, not just the
  // targeted one.
  const allActiveOrders = getActiveTrainingOrders(nk, userId);
  const currentSlots = computeSlotsUsed(nk, state.army);
  const queuedSlots = allActiveOrders.reduce((sum, o) => {
    const cfg = getUnitConfig(nk, o.unitId);
    return sum + o.quantity * (cfg ? cfg.slot_cost : 1);
  }, 0);
  const newSlots = req.quantity * unitCfg.slot_cost;
  const armyCap = getArmyCap(nk, state);
  if (currentSlots + queuedSlots + newSlots > armyCap) {
    return respond({ ok: false, error: 'army_cap_exceeded' });
  }

  const totalCost = {
    gold: unitCfg.train_cost_gold * req.quantity,
    crystal: unitCfg.train_cost_crystal * req.quantity,
    mithril: unitCfg.train_cost_mithril * req.quantity,
  };
  if (
    state.resources.gold < totalCost.gold ||
    state.resources.crystal < totalCost.crystal ||
    state.resources.mithril < totalCost.mithril
  ) {
    return respond({ ok: false, error: 'insufficient_resources' });
  }

  state.resources.gold -= totalCost.gold;
  state.resources.crystal -= totalCost.crystal;
  state.resources.mithril -= totalCost.mithril;
  writeKingdomState(nk, userId, state);

  const nowSeconds = Math.floor(Date.now() / 1000);
  const order: TrainingOrder = {
    orderId: nk.uuidv4(),
    buildingSlot: req.buildingSlot,
    unitId: req.unitId,
    quantity: req.quantity,
    perUnitSeconds: unitCfg.train_time_seconds,
    creditedQuantity: 0,
    startTick: nowSeconds,
    finishTick: nowSeconds + unitCfg.train_time_seconds * req.quantity,
    status: 'training',
  };
  writeTrainingOrder(nk, userId, order);

  return respond({ ok: true, order, resources: state.resources });
}

// Called from get_full_state (and any army-touching RPC), same lazy-resolve
// philosophy as completeFinishedUpgrades (buildings.ts) and the march
// sweep — a client never has to separately poll "is training done yet."
//
// TRICKLE, not all-at-once: units are credited to `army` one at a time as
// each one's individual train_time_seconds elapses — a 10-unit order does
// NOT wait for the full batch time and then dump all 10 in at once. Per the
// user's explicit design call: "aik unit ka time ka hisaab se aayen" (each
// unit arrives on its own time).
export function completeFinishedTrainingOrders(
  nk: nkruntime.Nakama,
  userId: string,
  state: KingdomState
): KingdomState {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const orders = getActiveTrainingOrders(nk, userId);
  for (const order of orders) {
    const elapsed = Math.max(0, nowSeconds - order.startTick);
    const unitsElapsed = Math.min(order.quantity, Math.floor(elapsed / order.perUnitSeconds));
    const newlyCredited = unitsElapsed - order.creditedQuantity;
    if (newlyCredited > 0) {
      state.army[order.unitId] = (state.army[order.unitId] || 0) + newlyCredited;
      order.creditedQuantity = unitsElapsed;
    }
    if (order.creditedQuantity >= order.quantity) {
      deleteTrainingOrder(nk, userId, order.orderId);
    } else if (newlyCredited > 0) {
      writeTrainingOrder(nk, userId, order); // persist partial progress so it isn't re-credited next read
    }
  }
  return state;
}

function respond(res: any): string {
  return JSON.stringify(res);
}

