// modules/economy/get_full_state.ts
import { readAndResolveKingdomState } from './resources';
import { completeFinishedUpgrades } from './buildings';
import { writeKingdomState } from './resources';

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
  writeKingdomState(nk, userId, completed);

  const response = {
    ok: true,
    kingdom: completed,
    army: [],       // Volume 5 — marching armies live in their own collection
    heroes: [],     // Volume 4 — hero roster
    alliance: completed.allianceId ? { id: completed.allianceId, stub: true } : null,
  };

  return JSON.stringify(response);
}
