// modules/combat/arrival.ts
// Volume 6. This is the actual "does a battle happen" decision point,
// called once per march at the moment it ARRIVES (worldmap/marches.ts's
// sweep). Confirmed rule set (per user, 2026-07-23):
//
//   - A tile with NO ONE currently stationed on it -> the arriving army
//     just occupies/stations there. No battle. This is what makes the
//     race-condition case work correctly: two different players can both
//     be mid-march toward a tile that was empty when they departed; the
//     one whose arrival is processed FIRST simply stations (no battle),
//     and the SECOND arrival then finds someone else's army already there
//     -> battle triggers for them. Nothing needs to check "was this a
//     race" explicitly — it falls out of "what's on the tile right now."
//   - A tile with the SAME player's own army already stationed -> the two
//     marches just merge (this player sent two waves to their own spot).
//     No battle, ever, against yourself.
//   - A tile with a DIFFERENT player's army (or an NPC garrison) already
//     stationed -> battle. Doesn't matter whether that army got there a
//     second ago or has been sitting there for days — same check either
//     way. player_castle always falls in this bucket (a city always has
//     an "owner" defending force, even if their KingdomState.army is 0).
//
// One function handles City Attack, Skeleton Village, Resource Tile, and
// Fortress/Temple alike — only the resolution mode (live-scene vs
// auto-resolve) and post-battle placement differ, same as battle.ts.

import { getTile } from '../worldmap/tiles';
import { getGarrison, saveGarrison } from './garrison';
import { resolveBattle, mergeTroops, isEmptyTroops } from './resolver';
import { recordBattleReport } from './report';
import { ArmyMarch } from '../worldmap/types';

export interface ArrivalOutcome {
  kind: 'stationed' | 'merged' | 'battle_resolved' | 'battle_pending';
  reportId?: number;
  winner?: 'attacker' | 'defender';
  survivingTroops?: Record<string, number>; // what the arriving player has left at this tile afterward (0 if they lost and nothing survived)
  mode?: 'city_attack' | 'skeleton_village' | 'resource_tile';
  defenderUserId?: string | null; // for 'battle_pending' — who/what the client's live scene will need to fight
}

export function resolveMarchArrival(
  nk: nkruntime.Nakama,
  logger: nkruntime.Logger,
  march: ArmyMarch
): ArrivalOutcome {
  const tile = getTile(nk, march.shardId, march.target);
  const tileType = tile ? tile.tileType : 'empty';
  const arrivingTroops = march.troops || {};

  if (tileType === 'player_castle') {
    // City Attack (§2.3/§2.4): arrival only OPENS the live battle scene —
    // it does not resolve combat by itself. Resolution happens once the
    // client finishes the manual deployment and calls
    // rpcResolveLiveBattle. This is also the §2.2 "lock trigger point":
    // the caller (sweep) should apply the defender-garrison lock the
    // moment this 'battle_pending' outcome comes back, per vol6.md §2.2.
    const defenderUserId = tile!.ownerUserId;
    if (!defenderUserId || defenderUserId === march.userId) {
      return { kind: 'stationed', survivingTroops: arrivingTroops };
    }
    return { kind: 'battle_pending', mode: 'city_attack', defenderUserId };
  }

  // Fortress/Temple/Skeleton Village/Resource Tile/plain ground — all
  // driven by "what's currently garrisoned on the tile."
  const garrison = getGarrison(nk, march.shardId, march.target, tileType);
  const defenderTroops = mergeTroops(garrison.npcTroops, garrison.stationedTroops);

  if (isEmptyTroops(defenderTroops)) {
    // Nobody here (or the tile's own NPC garrison was already wiped out
    // previously and never respawns) -> arriving army just occupies it.
    // No battle, regardless of whether this is the "first of two racing
    // marches" case or simply an uncontested tile.
    saveGarrison(nk, march.shardId, march.target, tileType, march.userId, {
      npcTroops: garrison.npcTroops, // stays {} if already wiped, or {} for plain ground
      stationedUserId: march.userId,
      stationedTroops: arrivingTroops,
      gatheredResources: garrison.gatheredResources,
    });
    return { kind: 'stationed', survivingTroops: arrivingTroops };
  }

  if (garrison.stationedUserId === march.userId) {
    // Same player's second wave to their own spot -> merge, never a
    // self-battle.
    const merged = mergeTroops(garrison.stationedTroops, arrivingTroops);
    saveGarrison(nk, march.shardId, march.target, tileType, march.userId, {
      ...garrison,
      stationedTroops: merged,
    });
    return { kind: 'merged', survivingTroops: merged };
  }

  // Someone else (a different player, and/or the tile's NPC garrison) is
  // here. Fortress/Temple stay auto-resolved (§4) — resolve right now.
  // Skeleton Village/Resource Tile use the live scene (§3.1/§3.2) —
  // signal 'battle_pending' the same way City Attack does, and let
  // rpcResolveLiveBattle finalize once the client plays it out.
  if (tileType === 'fortress' || tileType === 'temple') {
    const result = resolveBattle(nk, arrivingTroops, defenderTroops);
    const winnerIsAttacker = result.winner === 'attacker';
    saveGarrison(nk, march.shardId, march.target, tileType, winnerIsAttacker ? march.userId : garrison.stationedUserId, {
      // A defeated NPC garrison never respawns (confirmed rule) — only
      // survives the write if the DEFENDING side won.
      npcTroops: winnerIsAttacker ? {} : garrison.npcTroops,
      stationedUserId: winnerIsAttacker ? march.userId : garrison.stationedUserId,
      stationedTroops: winnerIsAttacker ? result.attackerSurvivors : garrison.stationedTroops,
    });
    const reportId = recordBattleReport(
      nk, march.shardId, march.target, tileType, 'structure',
      march.userId, garrison.stationedUserId, arrivingTroops, defenderTroops, result, null
    );
    return { kind: 'battle_resolved', reportId, winner: result.winner, survivingTroops: winnerIsAttacker ? result.attackerSurvivors : {} };
  }

  const mode = tileType === 'neutral_monster' ? 'skeleton_village' : 'resource_tile';
  return { kind: 'battle_pending', mode, defenderUserId: garrison.stationedUserId };
}