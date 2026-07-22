// modules/economy/get_full_state.ts
import { readAndResolveKingdomState } from './resources';
import { completeFinishedUpgrades } from './buildings';
import { writeKingdomState } from './resources';
import { completeFinishedTrainingOrders, getActiveTrainingOrders } from '../army/training';
import { completeFinishedHealOrders, getActiveHealOrders } from '../army/hospital';

// Single aggregated read on session start (§8.2). Placeholders for
// army/heroes/alliance are included now with the exact shape later volumes
// will fill in, so the client's deserialization code doesn't need to change
// when those volumes land — only the values go from stub to real.
export function rpcGetFullState(
  ctx: nkruntime.Context,
  logger: nkruntime.Logger,
  nk: nkruntime.Nakama,
  payload: string
): string {
  const userId = ctx.userId;
  if (!userId) {
    return JSON.stringify({ ok: false, error: 'unauthenticated' });
  }

  const resolved = readAndResolveKingdomState(nk, userId);
  const completed = completeFinishedUpgrades(resolved);
  // Volume 5: same lazy-resolve philosophy as building upgrades — a client
  // never has to separately poll "is training done" or "is a heal order
  // done yet". Hospital now works exactly like Training (queue + per-unit
  // time/cost), so both complete the same way.
  completeFinishedHealOrders(nk, userId, completed);
  completeFinishedTrainingOrders(nk, userId, completed);
  writeKingdomState(nk, userId, completed);

  const response = {
    ok: true,
    kingdom: completed,
    trainingQueue: getActiveTrainingOrders(nk, userId),   // Volume 5
    healQueue: getActiveHealOrders(nk, userId),           // Volume 5 (0009)
    army: [],       // marching armies (Volume 3 army_march) live in their own collection
    heroes: [],     // Volume 4 — hero roster
    alliance: completed.allianceId ? { id: completed.allianceId, stub: true } : null,
  };

  return JSON.stringify(response);
}
