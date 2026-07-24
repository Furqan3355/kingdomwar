// modules/combat/garrison.ts
// Volume 6. Reads/writes the TileGarrison payload inside world_tile's
// existing occupant_data JSON column (worldmap/tiles.ts) — deliberately no
// new per-tile table, per the note in 0010_combat_system.sql.

import { TileCoord } from '../worldmap/types';
import { TileGarrison, emptyGarrison } from './types';
import { decodeJsonbField } from '../util/jsonb';

function rowGarrison(occupantData: unknown): TileGarrison {
  if (!occupantData) return emptyGarrison();
  const parsed = decodeJsonbField<Partial<TileGarrison>>(occupantData);
  if (!parsed || typeof parsed !== 'object') return emptyGarrison();
  return {
    npcTroops: parsed.npcTroops || {},
    stationedUserId: parsed.stationedUserId ?? null,
    stationedTroops: parsed.stationedTroops || {},
    gatheredResources: parsed.gatheredResources,
  };
}

// Reads the current garrison for a tile, seeding the fixed NPC composition
// from npc_garrison_config the FIRST time a fortress/temple/neutral_monster
// tile is read with no occupant_data yet (i.e. it has never been fought
// over before). Once npcTroops has been written back as {} (fully wiped),
// it stays {} forever — no re-seed — per the confirmed "NPC doesn't
// respawn once defeated" rule.
export function getGarrison(
  nk: nkruntime.Nakama,
  shardId: number,
  coord: TileCoord,
  tileType: string
): TileGarrison {
  const result = nk.sqlQuery(
    `SELECT occupant_data FROM world_tile WHERE shard_id = $1 AND x = $2 AND y = $3`,
    [shardId, coord.x, coord.y]
  );

  if (result && result.length > 0 && result[0].occupant_data) {
    return rowGarrison(result[0].occupant_data);
  }

  // No row / no occupant_data yet — this tile has never been touched by
  // combat. For garrisoned tile types, seed from npc_garrison_config so the
  // first attacker fights the intended starting force rather than nothing.
  if (tileType === 'fortress' || tileType === 'temple' || tileType === 'neutral_monster') {
    const cfg = nk.sqlQuery(`SELECT troops FROM npc_garrison_config WHERE tile_type = $1`, [tileType]);
    const npcTroops = cfg && cfg.length > 0 ? decodeJsonbField<Record<string, number>>(cfg[0].troops) : {};
    return { npcTroops, stationedUserId: null, stationedTroops: {} };
  }

  return emptyGarrison();
}

// Persists a garrison back onto the tile's occupant_data, upserting the
// world_tile row if it doesn't exist yet (same atomic update-then-insert
// pattern as worldmap/tiles.ts::claimTile, minus the "must be empty"
// condition since combat is allowed to overwrite an existing garrison).
export function saveGarrison(
  nk: nkruntime.Nakama,
  shardId: number,
  coord: TileCoord,
  tileType: string,
  ownerUserId: string | null,
  garrison: TileGarrison
): void {
  const nowTick = Math.floor(Date.now() / 1000);
  const payload = JSON.stringify(garrison);

  const updateResult = nk.sqlExec(
    `UPDATE world_tile
     SET tile_type = $1, owner_user_id = $2, occupant_data = $3,
         last_updated_tick = $4, version = version + 1
     WHERE shard_id = $5 AND x = $6 AND y = $7`,
    [tileType, ownerUserId, payload, nowTick, shardId, coord.x, coord.y]
  );
  if (updateResult && updateResult.rowsAffected > 0) return;

  nk.sqlExec(
    `INSERT INTO world_tile (shard_id, x, y, tile_type, owner_user_id, owner_alliance_id, occupant_data, last_updated_tick, version)
     VALUES ($1, $2, $3, $4, NULL, $5, $6, 1)
     ON CONFLICT (shard_id, x, y) DO UPDATE
       SET tile_type = EXCLUDED.tile_type, owner_user_id = EXCLUDED.owner_user_id,
           occupant_data = EXCLUDED.occupant_data, last_updated_tick = EXCLUDED.last_updated_tick,
           version = world_tile.version + 1`,
    [shardId, coord.x, coord.y, tileType, ownerUserId, payload, nowTick]
  );
}

// Manual withdrawal (§3.3 / §4a) — the stationed player pulls their surviving
// army off the tile. Combat-side bookkeeping only: this clears the
// garrison's stationed slot and hands the troop counts back to the caller.
//
// IMPORTANT: withdrawing does NOT force a march back to the player's city.
// The freed troops can be sent ANYWHERE via the existing march system
// (worldmap/marches.ts::rpcStartMarch) using this tile's coordinate as the
// `origin` — home city, a different resource tile to gather at, or
// straight into an attack on another fortress/temple/skeleton village.
// This module only owns "is this army still sitting on the tile or not";
// where it goes next is entirely the caller's/player's choice, same
// separation-of-concerns as the rest of this codebase (Volume 3 owns
// march timing/targeting, Volume 5 owns army storage, this module only
// owns the tile's combat/garrison state).
export function withdrawStationedArmy(
  nk: nkruntime.Nakama,
  shardId: number,
  coord: TileCoord,
  tileType: string,
  userId: string
): Record<string, number> | null {
  const garrison = getGarrison(nk, shardId, coord, tileType);
  if (garrison.stationedUserId !== userId) return null;

  const withdrawnTroops = garrison.stationedTroops;
  garrison.stationedUserId = null;
  garrison.stationedTroops = {};
  garrison.gatheredResources = undefined;
  saveGarrison(nk, shardId, coord, tileType, null, garrison);
  return withdrawnTroops;
}