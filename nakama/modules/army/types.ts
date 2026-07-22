// modules/army/types.ts
// Volume 5. TrainingOrder is stored in its OWN storage collection
// (training_queue, per-player, keyed by orderId) — same
// write-frequency-separation rule as marches (Volume 3) and building
// upgrades: it changes on a different cadence than the rest of
// KingdomState, so it doesn't belong inlined into the kingdom blob.

export interface TrainingOrder {
  orderId: string;
  buildingSlot: string; // which specific Barracks (e.g. '10_10') this order's queue slot is reserved against
  unitId: string;
  quantity: number;
  perUnitSeconds: number; // how long ONE unit takes — used to trickle-credit units as time passes, not all at once
  creditedQuantity: number; // how many units from this order have already been added to `army` so far
  startTick: number;
  finishTick: number;
  status: 'training' | 'complete';
}

export const TRAINING_COLLECTION = 'training_queue';

// Hospital heal queue (0009_hospital_queue.sql) — deliberately identical
// shape to TrainingOrder, since Hospital now works exactly like Training:
// its own storage collection, one queue slot per active order regardless
// of quantity, resources spent up front, units trickle back into `army`
// one at a time as each one's heal time completes (not all at once).
export interface HealOrder {
  orderId: string;
  buildingSlot: string; // which specific Hospital (e.g. '12_12') this order's queue slot is reserved against
  unitId: string;
  quantity: number;
  perUnitSeconds: number;
  creditedQuantity: number;
  startTick: number;
  finishTick: number;
  status: 'healing' | 'complete';
}

export const HOSPITAL_COLLECTION = 'hospital_queue';

// § Unit Size / Render Grouping. Pure data shape — Volume 6's battlefield
// renderer/combat resolver is the actual consumer of this; Volume 5 only
// produces it.
export interface RenderGroup {
  unitId: string;
  troopCount: number;      // how many real troops are in this stack (<= unitSize, except full groups)
  attackShare: number;     // troopCount / unitSize — fraction of a "full" group's combat stats this group fights at
}
