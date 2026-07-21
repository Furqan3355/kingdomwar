// modules/worldmap/teleport.ts
// Volume 3 §9.

import { readKingdomState } from '../economy/resources';
import { getActiveMarchesForUser } from './marches';
import { claimTile, vacateTile, findRandomEmptyTileNear, getTile } from './tiles';
import { TileCoord } from './types';

export function rpcTeleportCastle(
  ctx: nkruntime.Context,
  logger: nkruntime.Logger,
  nk: nkruntime.Nakama,
  payload: string
): string {
  const userId = ctx.userId;
  if (!userId) return JSON.stringify({ ok: false, error: 'unauthenticated' });

  // §9.3 safety constraint: reject if any march is in flight. Reads off
  // idx_army_march_user_active — cheap regardless of shard-wide march volume.
  const active = getActiveMarchesForUser(nk, userId);
  if (active.length > 0) {
    return JSON.stringify({ ok: false, error: 'march_in_flight' });
  }

  const state = readKingdomState(nk, userId);
  if (!state) return JSON.stringify({ ok: false, error: 'no_kingdom_state' });

  const req = JSON.parse(payload) as { targetX?: number; targetY?: number };

  const currentCastle = findPlayerCastleTile(nk, state.shardId, userId);
  if (!currentCastle) return JSON.stringify({ ok: false, error: 'no_castle_tile_found' });

  let target: TileCoord | null;
  if (req.targetX !== undefined && req.targetY !== undefined) {
    // Explicit-coordinate teleport. Zone-boundary gating (castle-level vs.
    // region) is a Volume 2-style config-gate check — left as a TODO hook
    // here since it depends on a zone-config table this volume doesn't
    // define; do not ship explicit-coordinate teleport to production
    // without wiring that check first (§9.3).
    target = { x: req.targetX, y: req.targetY };
  } else {
    target = findRandomEmptyTileNear(nk, state.shardId, currentCastle, 50);
  }
  if (!target) return JSON.stringify({ ok: false, error: 'no_valid_destination_found' });

  const claimed = claimTile(nk, state.shardId, target, { tileType: 'player_castle', ownerUserId: userId });
  if (!claimed) return JSON.stringify({ ok: false, error: 'destination_occupied' });

  vacateTile(nk, state.shardId, currentCastle);

  return JSON.stringify({ ok: true, newCoord: target });
}

// A player's castle tile isn't tracked as a direct field on KingdomState in
// this scaffold (avoids a second source of truth vs. the world_tile row
// itself) — looked up via the owner index instead.
function findPlayerCastleTile(nk: nkruntime.Nakama, shardId: number, userId: string): TileCoord | null {
  const result = nk.sqlQuery(
    `SELECT x, y FROM world_tile WHERE shard_id = $1 AND owner_user_id = $2 AND tile_type = 'player_castle' LIMIT 1`,
    [shardId, userId]
  );
  if (!result || result.length === 0) return null;
  return { x: Number(result[0].x), y: Number(result[0].y) };
}