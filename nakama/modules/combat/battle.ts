// modules/combat/battle.ts
// Volume 6 RPCs. Per vol6.md §6: exact RPC payloads were explicitly
// deferred in the original draft. These are a first concrete cut, built to
// slot into the existing march system (worldmap/marches.ts) the same way
// every other march-driven system does — attack RPCs here fire once an
// 'attack'-type march has ARRIVED (client calls these after getting an
// arrival notice, or a server-side sweep can call them the same way
// sweep_march_arrivals resolves 'gather'/'reinforce' marches).
//
// City Attack / Skeleton Village / Resource Tile all share ONE resolver
// entry point (rpcResolveLiveBattle) because they share the identical live
// battle scene and troop math — only defender lookup, post-battle army
// placement, and loot differ, and those are handled by the `mode` switch
// inside this one function rather than three near-duplicate RPCs.

import { TileCoord } from '../worldmap/types';
import { getGarrison, saveGarrison, withdrawStationedArmy } from './garrison';
import { resolveBattle, mergeTroops, isEmptyTroops } from './resolver';
import { BattleMode } from './types';

function recordBattleReport(
  nk: nkruntime.Nakama,
  shardId: number,
  coord: TileCoord,
  tileType: string,
  mode: BattleMode,
  attackerUserId: string,
  defenderUserId: string | null,
  attackerTroopsBefore: Record<string, number>,
  defenderTroopsBefore: Record<string, number>,
  result: ReturnType<typeof resolveBattle>,
  loot: Record<string, number> | null
): number | null {
  const nowTick = Math.floor(Date.now() / 1000);
  const inserted = nk.sqlQuery(
    `INSERT INTO battle_report
       (shard_id, tile_x, tile_y, tile_type, mode, attacker_user_id, defender_user_id,
        attacker_troops_before, defender_troops_before, attacker_losses, defender_losses,
        attacker_survivors, defender_survivors, winner, loot, resolved_tick)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     RETURNING report_id`,
    [
      shardId, coord.x, coord.y, tileType, mode, attackerUserId, defenderUserId,
      JSON.stringify(attackerTroopsBefore), JSON.stringify(defenderTroopsBefore),
      JSON.stringify(result.attackerLosses), JSON.stringify(result.defenderLosses),
      JSON.stringify(result.attackerSurvivors), JSON.stringify(result.defenderSurvivors),
      result.winner, loot ? JSON.stringify(loot) : null, nowTick,
    ]
  );
  return inserted && inserted[0] ? Number(inserted[0].report_id) : null;
}

// ============================================================
// City Attack / Skeleton Village / Resource Tile (live-scene modes)
// ============================================================

export interface ResolveLiveBattleRequest {
  shardId: number;
  target: TileCoord;
  tileType: 'player_castle' | 'neutral_monster' | 'resource_node';
  // Troops the attacker deployed in the live scene. Validating that these
  // are actually the troops in-transit on this march (and not a client-
  // inflated number) is Volume 5/Volume 3 territory (army-ownership +
  // march-payload checks) — out of scope for this combat-math RPC, same
  // deferral vol6.md itself calls out for §2.2/§3 elsewhere in this doc.
  attackerTroops: Record<string, number>;
  // Required for 'player_castle': the defending player's garrison is read
  // from THEIR KingdomState.army by the caller before invoking this, since
  // combat.ts intentionally has no dependency on economy/resources.ts to
  // avoid a circular-import edge with how KingdomState already imports
  // from Vol1-5 modules. Passed in pre-resolved.
  defenderTroopsOverride?: Record<string, number>;
  defenderUserIdOverride?: string;
}

export function rpcResolveLiveBattle(
  ctx: nkruntime.Context,
  logger: nkruntime.Logger,
  nk: nkruntime.Nakama,
  payload: string
): string {
  const userId = ctx.userId;
  if (!userId) return JSON.stringify({ ok: false, error: 'unauthenticated' });

  const req = JSON.parse(payload) as ResolveLiveBattleRequest;
  if (isEmptyTroops(req.attackerTroops)) {
    return JSON.stringify({ ok: false, error: 'no_attacker_troops' });
  }

  let mode: BattleMode;
  let defenderUserId: string | null = null;
  let defenderTroops: Record<string, number>;

  if (req.tileType === 'player_castle') {
    // City Attack (§2). Defender garrison comes from the caller, since it's
    // the target player's own KingdomState.army (economy/resources.ts) —
    // this module never reads another player's private storage directly.
    mode = 'city_attack';
    defenderUserId = req.defenderUserIdOverride ?? null;
    defenderTroops = req.defenderTroopsOverride ?? {};
    if (!defenderUserId) return JSON.stringify({ ok: false, error: 'missing_defender_for_city_attack' });
  } else {
    // Skeleton Village (§3.1) or Resource Tile (§3.2) — defender is
    // whatever's currently on the tile: NPC garrison alone (Skeleton
    // Village, until first defeated) or a stationed player's army
    // (Resource Tile, or a Skeleton Village a prior winner stationed at).
    mode = req.tileType === 'neutral_monster' ? 'skeleton_village' : 'resource_tile';
    const garrison = getGarrison(nk, req.shardId, req.target, req.tileType);
    defenderUserId = garrison.stationedUserId;
    defenderTroops = mergeTroops(garrison.npcTroops, garrison.stationedTroops);
    if (isEmptyTroops(defenderTroops)) {
      return JSON.stringify({ ok: false, error: 'tile_undefended' }); // nothing to fight — caller should just walk in, not call this RPC
    }
  }

  const attackerTroopsBefore = { ...req.attackerTroops };
  const defenderTroopsBefore = { ...defenderTroops };
  const result = resolveBattle(nk, req.attackerTroops, defenderTroops);

  let loot: Record<string, number> | null = null;

  if (req.tileType === 'player_castle') {
    // §2.5: attacker's surviving army marches home — the caller (worldmap
    // march RPCs) is responsible for actually starting that return march;
    // this RPC only returns the survivor counts for it to use.
    // §2.6/§2.7: loot capacity + defender wound-split are Volume 5/economy
    // concerns (carry capacity, hospital.woundedTroops) — caller applies
    // those using result.defenderLosses / result.winner.
  } else {
    // §3.3: winner's surviving army stays stationed ON the tile — never
    // marches home automatically, regardless of who wins.
    const survivorsToStation = result.winner === 'attacker' ? result.attackerSurvivors : defenderTroops /* defender already there */;
    const stationedOwner = result.winner === 'attacker' ? userId : defenderUserId;

    const priorGarrison = getGarrison(nk, req.shardId, req.target, req.tileType);
    const npcSurvived = result.winner === 'defender'; // NPC/stationed side won — its NPC component (if any) persists as-is
    saveGarrison(nk, req.shardId, req.target, req.tileType, stationedOwner, {
      npcTroops: npcSurvived ? priorGarrison.npcTroops : {}, // NPC component only survives if the defending side won outright; a defeated NPC never respawns (§ open item)
      stationedUserId: result.winner === 'attacker' ? userId : priorGarrison.stationedUserId,
      stationedTroops: result.winner === 'attacker' ? result.attackerSurvivors : priorGarrison.stationedTroops,
      gatheredResources:
        req.tileType === 'resource_node' && result.winner === 'attacker' && result.defenderFullyWiped
          ? undefined // full-wipe: resources transfer OUT to attacker (below), tile's own pool clears
          : priorGarrison.gatheredResources,
    });

    // §Resource Tile loot rule: attacker fully wipes the gathering
    // defender -> that defender's gathered-so-far resources transfer.
    if (req.tileType === 'resource_node' && result.winner === 'attacker' && result.defenderFullyWiped) {
      loot = priorGarrison.gatheredResources ?? null;
    }
    void survivorsToStation; // kept for clarity of intent above; actual value already folded into saveGarrison call
  }

  const reportId = recordBattleReport(
    nk, req.shardId, req.target, req.tileType, mode, userId, defenderUserId,
    attackerTroopsBefore, defenderTroopsBefore, result, loot
  );

  return JSON.stringify({
    ok: true,
    reportId,
    winner: result.winner,
    attackerSurvivors: result.attackerSurvivors,
    defenderSurvivors: result.defenderSurvivors,
    attackerLosses: result.attackerLosses,
    defenderLosses: result.defenderLosses,
    loot,
    armyReturnsHome: req.tileType === 'player_castle', // false for skeleton_village/resource_tile per §3.3
  });
}

// ============================================================
// Fortress / Temple (auto-resolved, always-garrisoned — §4)
// ============================================================

export interface ResolveStructureBattleRequest {
  shardId: number;
  target: TileCoord;
  tileType: 'fortress' | 'temple';
  attackerTroops: Record<string, number>;
}

export function rpcResolveStructureBattle(
  ctx: nkruntime.Context,
  logger: nkruntime.Logger,
  nk: nkruntime.Nakama,
  payload: string
): string {
  const userId = ctx.userId;
  if (!userId) return JSON.stringify({ ok: false, error: 'unauthenticated' });

  const req = JSON.parse(payload) as ResolveStructureBattleRequest;
  if (isEmptyTroops(req.attackerTroops)) {
    return JSON.stringify({ ok: false, error: 'no_attacker_troops' });
  }

  const garrison = getGarrison(nk, req.shardId, req.target, req.tileType);
  // §4: NPC garrison + whatever player army is currently stationed there
  // fight TOGETHER as one combined defending force — confirmed rule, not
  // "winner's army replaces the NPC garrison."
  const defenderTroops = mergeTroops(garrison.npcTroops, garrison.stationedTroops);
  const defenderUserId = garrison.stationedUserId;

  const attackerTroopsBefore = { ...req.attackerTroops };
  const defenderTroopsBefore = { ...defenderTroops };
  const result = resolveBattle(nk, req.attackerTroops, defenderTroops);

  if (result.winner === 'attacker') {
    // NPC component is defeated permanently (no respawn — same open-item
    // assumption as Skeleton Village, flagged in vol6.md §6). Any prior
    // stationed player's troops that were part of this combined defense
    // are gone too (they lost). Attacker's survivors become the new sole
    // stationed force.
    saveGarrison(nk, req.shardId, req.target, req.tileType, userId, {
      npcTroops: {},
      stationedUserId: userId,
      stationedTroops: result.attackerSurvivors,
    });
  }
  // On a defender win, the garrison is left untouched (NPC + prior
  // stationed troops both already reflect their pre-battle counts, since
  // the loser here is the attacker and nothing about the tile changes).

  const reportId = recordBattleReport(
    nk, req.shardId, req.target, req.tileType, 'structure', userId, defenderUserId,
    attackerTroopsBefore, defenderTroopsBefore, result, null
  );

  return JSON.stringify({
    ok: true,
    reportId,
    winner: result.winner,
    attackerSurvivors: result.attackerSurvivors,
    defenderSurvivors: result.defenderSurvivors,
    attackerLosses: result.attackerLosses,
    defenderLosses: result.defenderLosses,
  });
}

// ============================================================
// Manual withdrawal of a stationed army (§3.3 / §4a)
// ============================================================

export function rpcWithdrawStationedArmy(
  ctx: nkruntime.Context,
  logger: nkruntime.Logger,
  nk: nkruntime.Nakama,
  payload: string
): string {
  const userId = ctx.userId;
  if (!userId) return JSON.stringify({ ok: false, error: 'unauthenticated' });

  const req = JSON.parse(payload) as { shardId: number; target: TileCoord; tileType: string };
  const withdrawn = withdrawStationedArmy(nk, req.shardId, req.target, req.tileType, userId);
  if (withdrawn === null) {
    return JSON.stringify({ ok: false, error: 'no_stationed_army_for_user' });
  }
  // Caller starts the actual return march (worldmap/marches.ts) with these
  // troop counts — this RPC only clears the tile-side bookkeeping.
  return JSON.stringify({ ok: true, troops: withdrawn });
}