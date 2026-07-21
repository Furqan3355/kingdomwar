// modules/economy/admin_cleanup.ts
//
// One-time repair RPC for the "duplicate castle / orphan building" bug.
// Two independent problems this fixes in every player's already-saved
// KingdomState:
//
//   1. SINGLETON DUPLICATES — a building type that should only ever exist
//      once (Castle, Command Center) has more than one entry in
//      state.buildings, because place_building had no singleton check
//      before this fix (see placement.ts). Keeps the HIGHEST-level
//      instance, deletes the rest, and re-syncs castleLevel to match
//      whichever castle instance survives.
//
//   2. ORPHAN BUILDINGS — a building instance whose buildingId no longer
//      has a row in building_config at all (e.g. 'gold_factory', removed
//      entirely in migration 0004_redesign_v2.sql). These can never be
//      upgraded (getBuildingConfig returns null) and never get cleaned up
//      on their own — a config-table migration does not touch already-
//      saved player storage rows. Deletes any such instance.
//
// This is NOT wired into any player-facing flow — it's an admin-only RPC,
// meant to be invoked once (via Nakama console / a curl call with an admin
// auth token) after deploying the placement.ts fix, then it can be removed.
//
// Call with an empty payload: {}
// Response: { ok: true, playersScanned, playersFixed, details: [...] }

import { KingdomState, KINGDOM_COLLECTION, KINGDOM_KEY } from '../types';
import { getBuildingConfig } from '../config/loader';
import { writeKingdomState } from './resources';

// Keep this list identical to placement.ts's SINGLETON_BUILDINGS — if one
// changes, the other must too.
const SINGLETON_BUILDINGS = ['castle', 'command_center'];

interface CleanupDetail {
  userId: string;
  removedSingletonDuplicates: string[]; // keys removed, e.g. "castle:10_4"
  removedOrphans: string[];             // keys removed, e.g. "gold_factory:1_1"
  newCastleLevel: number | null;        // set only if castle was touched
}

export function rpcAdminCleanupBuildings(
  ctx: nkruntime.Context,
  logger: nkruntime.Logger,
  nk: nkruntime.Nakama,
  payload: string
): string {
  // NOTE: lock this RPC down at the Nakama config / API-gateway level
  // (admin-only auth) before deploying — it rewrites every player's
  // storage object. It intentionally does not check ctx.userId itself,
  // since it isn't meant to be called by a regular player session at all.

  let playersScanned = 0;
  let playersFixed = 0;
  const details: CleanupDetail[] = [];

  let cursor: string | undefined = undefined;

  do {
    // userId=null scans across ALL users' objects in this collection, not
    // just one — that's what makes this a bulk admin sweep rather than a
    // per-player fix.
    const result = nk.storageList(undefined, KINGDOM_COLLECTION, 100, cursor);
    const objects = result.objects || [];

    for (const obj of objects) {
      if (obj.key !== KINGDOM_KEY) continue; // safety: only touch kingdom/state rows
      playersScanned++;

      const state = obj.value as KingdomState;
      const detail: CleanupDetail = {
        userId: obj.userId as string,
        removedSingletonDuplicates: [],
        removedOrphans: [],
        newCastleLevel: null,
      };
      let changed = false;

      // --- Problem 1: singleton duplicates ---
      for (const buildingId of SINGLETON_BUILDINGS) {
        const matchingKeys: string[] = [];
        for (const k in state.buildings) {
          if (state.buildings[k].buildingId === buildingId) matchingKeys.push(k);
        }
        if (matchingKeys.length <= 1) continue;

        // Keep the highest level; if tied, keep the one with the lowest
        // upgradeFinishTick (i.e. the one closer to finishing / not mid-
        // upgrade), then just the first key as a final tiebreaker.
        matchingKeys.sort((a, b) => {
          const ba = state.buildings[a];
          const bb = state.buildings[b];
          if (bb.level !== ba.level) return bb.level - ba.level;
          const ta = ba.upgradeFinishTick === null ? -1 : ba.upgradeFinishTick;
          const tb = bb.upgradeFinishTick === null ? -1 : bb.upgradeFinishTick;
          return ta - tb;
        });

        const keep = matchingKeys[0];
        for (let i = 1; i < matchingKeys.length; i++) {
          const removeKey = matchingKeys[i];
          detail.removedSingletonDuplicates.push(removeKey);
          delete state.buildings[removeKey];
          changed = true;
        }

        if (buildingId === 'castle') {
          const keptLevel = state.buildings[keep].level;
          if (state.castleLevel !== keptLevel) {
            state.castleLevel = keptLevel;
            detail.newCastleLevel = keptLevel;
            changed = true;
          }
        }
      }

      // --- Problem 2: orphaned buildings (no config row anymore) ---
      for (const k in state.buildings) {
        const b = state.buildings[k];
        const cfg = getBuildingConfig(nk, b.buildingId);
        if (!cfg) {
          detail.removedOrphans.push(k);
          delete state.buildings[k];
          changed = true;
        }
      }

      if (changed) {
        writeKingdomState(nk, detail.userId, state);
        playersFixed++;
        details.push(detail);
        logger.info(
          'admin_cleanup_buildings: fixed user %s (removed %d singleton dupes, %d orphans)',
          detail.userId,
          detail.removedSingletonDuplicates.length,
          detail.removedOrphans.length
        );
      }
    }

    cursor = result.cursor ?? undefined;
  } while (cursor);

  return JSON.stringify({
    ok: true,
    playersScanned,
    playersFixed,
    details,
  });
}