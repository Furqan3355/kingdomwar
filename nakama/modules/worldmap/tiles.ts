// modules/worldmap/tiles.ts
// Volume 3 §2/§3. Tiles live in Postgres (see 0006_world_map.sql for why),
// not Nakama's generic storage — this module is the only place that talks
// to the world_tile table directly.

import { WorldTile, TileCoord, TileType, isInBounds, MAX_VIEWPORT_TILES } from './types';

function rowToTile(row: any): WorldTile {
  return {
    shardId: Number(row.shard_id),
    x: Number(row.x),
    y: Number(row.y),
    tileType: row.tile_type,
    ownerUserId: row.owner_user_id,
    ownerAllianceId: row.owner_alliance_id,
    occupantData: row.occupant_data,
    lastUpdatedTick: Number(row.last_updated_tick),
    version: Number(row.version),
  };
}

export function getTile(nk: nkruntime.Nakama, shardId: number, coord: TileCoord): WorldTile | null {
  const result = nk.sqlQuery(
    `SELECT shard_id, x, y, tile_type, owner_user_id, owner_alliance_id, occupant_data, last_updated_tick, version
     FROM world_tile WHERE shard_id = $1 AND x = $2 AND y = $3`,
    [shardId, coord.x, coord.y]
  );
  if (!result || result.length === 0) {
    // Untouched tiles are never pre-seeded (that would mean writing a row for
    // every one of a shard's ~1M tiles up front). Absence of a row === empty.
    return {
      shardId, x: coord.x, y: coord.y, tileType: 'empty',
      ownerUserId: null, ownerAllianceId: null, occupantData: null,
      lastUpdatedTick: 0, version: 0,
    };
  }
  return rowToTile(result[0]);
}

// Range scan for a viewport — this is the hot path (every connected client
// polls its visible box). Backed directly by the (shard_id, x, y) primary
// key, so this is a single indexed range scan, not a full-table or
// full-region scan. Capped at MAX_VIEWPORT_TILES so a malicious/buggy
// client can't request the whole 1024x1024 grid in one call.
export function getTilesInViewport(
  nk: nkruntime.Nakama,
  shardId: number,
  minX: number, maxX: number, minY: number, maxY: number
): WorldTile[] {
  const width = maxX - minX + 1;
  const height = maxY - minY + 1;
  if (width <= 0 || height <= 0 || width * height > MAX_VIEWPORT_TILES) {
    throw Error(`viewport_too_large: max ${MAX_VIEWPORT_TILES} tiles per request`);
  }

  const result = nk.sqlQuery(
    `SELECT shard_id, x, y, tile_type, owner_user_id, owner_alliance_id, occupant_data, last_updated_tick, version
     FROM world_tile
     WHERE shard_id = $1 AND x BETWEEN $2 AND $3 AND y BETWEEN $4 AND $5`,
    [shardId, minX, maxX, minY, maxY]
  );

  // Rows only exist for non-empty tiles (see getTile above), so we start
  // from an all-empty grid of the requested box and overlay the rows that
  // exist — this way the client always gets a dense, predictable box back
  // without the server having to materialize a row per empty tile.
  const byKey = new Map<string, WorldTile>();
  for (const row of result || []) {
    const t = rowToTile(row);
    byKey.set(`${t.x}_${t.y}`, t);
  }

  const tiles: WorldTile[] = [];
  for (let x = minX; x <= maxX; x++) {
    for (let y = minY; y <= maxY; y++) {
      const existing = byKey.get(`${x}_${y}`);
      tiles.push(existing || {
        shardId, x, y, tileType: 'empty',
        ownerUserId: null, ownerAllianceId: null, occupantData: null,
        lastUpdatedTick: 0, version: 0,
      });
    }
  }
  return tiles;
}

export interface ClaimTileParams {
  tileType: TileType;
  ownerUserId?: string | null;
  ownerAllianceId?: string | null;
  occupantData?: unknown;
}

// Atomic claim: a single conditional UPDATE (or INSERT if the tile has
// never been touched before) rather than Volume 3 doc's read-then-write
// pattern. Doing it as one statement with the "must currently be empty"
// condition in the WHERE clause means Postgres's own row-level locking
// resolves the race — no read-modify-write window where two players could
// both think they got it. Returns false if the tile was already claimed by
// the time this ran (caller shows "already claimed", per §2.3's guidance:
// no retry loop, no livelock).
export function claimTile(
  nk: nkruntime.Nakama,
  shardId: number,
  coord: TileCoord,
  params: ClaimTileParams
): boolean {
  if (!isInBounds(coord)) throw Error('out_of_bounds');
  const nowTick = Math.floor(Date.now() / 1000);

  // Try the update path first (row exists and is empty).
  const updateResult = nk.sqlExec(
    `UPDATE world_tile
     SET tile_type = $1, owner_user_id = $2, owner_alliance_id = $3,
         occupant_data = $4, last_updated_tick = $5, version = version + 1
     WHERE shard_id = $6 AND x = $7 AND y = $8 AND tile_type = 'empty'`,
    [params.tileType, params.ownerUserId ?? null, params.ownerAllianceId ?? null,
     JSON.stringify(params.occupantData ?? null), nowTick, shardId, coord.x, coord.y]
  );
  if (updateResult && updateResult.rowsAffected > 0) return true;

  // Row doesn't exist yet (tile never touched before) — insert it. The
  // ON CONFLICT DO NOTHING guards the race where two requests both hit the
  // "row doesn't exist" branch simultaneously; only one insert wins, the
  // loser's rowsAffected comes back 0 and correctly reports "not claimed".
  const insertResult = nk.sqlExec(
    `INSERT INTO world_tile (shard_id, x, y, tile_type, owner_user_id, owner_alliance_id, occupant_data, last_updated_tick, version)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1)
     ON CONFLICT (shard_id, x, y) DO NOTHING`,
    [shardId, coord.x, coord.y, params.tileType, params.ownerUserId ?? null,
     params.ownerAllianceId ?? null, JSON.stringify(params.occupantData ?? null), nowTick]
  );
  return !!insertResult && insertResult.rowsAffected > 0;
}

// Vacate — used by teleport (old tile) and depleted resource nodes.
export function vacateTile(nk: nkruntime.Nakama, shardId: number, coord: TileCoord): void {
  nk.sqlExec(
    `UPDATE world_tile
     SET tile_type = 'empty', owner_user_id = NULL, owner_alliance_id = NULL,
         occupant_data = NULL, last_updated_tick = $1, version = version + 1
     WHERE shard_id = $2 AND x = $3 AND y = $4`,
    [Math.floor(Date.now() / 1000), shardId, coord.x, coord.y]
  );
}

// Finds an empty tile near a point by sampling random offsets within a
// radius and retrying — cheap and correct at typical placement density
// (newbie zones / relocate targets are chosen specifically because they're
// low-contention, per §8.3). Bounded attempt count so this can never hang.
export function findRandomEmptyTileNear(
  nk: nkruntime.Nakama,
  shardId: number,
  center: TileCoord,
  radius: number,
  maxAttempts = 30
): TileCoord | null {
  for (let i = 0; i < maxAttempts; i++) {
    const dx = Math.floor(Math.random() * (radius * 2 + 1)) - radius;
    const dy = Math.floor(Math.random() * (radius * 2 + 1)) - radius;
    const candidate = { x: center.x + dx, y: center.y + dy };
    if (!isInBounds(candidate)) continue;
    const tile = getTile(nk, shardId, candidate);
    if (tile.tileType === 'empty') return candidate;
  }
  return null;
}

// ============================================================
// RPCs
// ============================================================

export function rpcGetWorldView(
  ctx: nkruntime.Context,
  logger: nkruntime.Logger,
  nk: nkruntime.Nakama,
  payload: string
): string {
  const req = JSON.parse(payload) as { shardId: number; minX: number; maxX: number; minY: number; maxY: number };
  try {
    const tiles = getTilesInViewport(nk, req.shardId, req.minX, req.maxX, req.minY, req.maxY);
    return JSON.stringify({ ok: true, tiles });
  } catch (e) {
    return JSON.stringify({ ok: false, error: (e as Error).message });
  }
}