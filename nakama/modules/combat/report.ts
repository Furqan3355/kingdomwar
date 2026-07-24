// modules/combat/report.ts
// Volume 6. Shared by battle.ts (client-driven live-scene finalize RPCs)
// and arrival.ts (automatic resolution on march arrival) so both write
// battle_report rows the exact same way.

import { TileCoord } from '../worldmap/types';
import { BattleMode, BattleResult } from './types';

export function recordBattleReport(
  nk: nkruntime.Nakama,
  shardId: number,
  coord: TileCoord,
  tileType: string,
  mode: BattleMode,
  attackerUserId: string,
  defenderUserId: string | null,
  attackerTroopsBefore: Record<string, number>,
  defenderTroopsBefore: Record<string, number>,
  result: BattleResult,
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