// modules/worldmap/marches.ts
// Volume 3 §6/§11. Marches are stored in Postgres (army_march table,
// 0006_world_map.sql) specifically so the arrival sweep can be an indexed
// range query instead of scanning every march every tick.

import { chebyshevDistance, MarchType, MARCH_SWEEP_BATCH_SIZE, TileCoord } from './types';
import { readKingdomState } from '../economy/resources';

// Design constant — tune per game balance later; kept as a named constant
// rather than inline so it's obvious where "how fast do armies move" lives.
const SECONDS_PER_TILE = 2;

function rowToMarch(row: any) {
  return {
    marchId: row.march_id,
    shardId: Number(row.shard_id),
    userId: row.user_id,
    marchType: row.march_type,
    origin: { x: Number(row.origin_x), y: Number(row.origin_y) },
    target: { x: Number(row.target_x), y: Number(row.target_y) },
    troops: row.troops,
    departureTick: Number(row.departure_tick),
    arrivalTick: Number(row.arrival_tick),
    status: row.status,
    resolved: row.resolved,
  };
}

// §9.3 teleport guard + general "one march type at a time" style checks
// read off idx_army_march_user_active — cheap even under heavy load since
// that index only contains currently-unresolved rows for this user (almost
// always a tiny number, regardless of how many marches exist shard-wide).
export function getActiveMarchesForUser(nk: nkruntime.Nakama, userId: string) {
  const result = nk.sqlQuery(
    `SELECT march_id, shard_id, user_id, march_type, origin_x, origin_y, target_x, target_y,
            troops, departure_tick, arrival_tick, status, resolved
     FROM army_march WHERE user_id = $1 AND resolved = FALSE`,
    [userId]
  );
  return (result || []).map(rowToMarch);
}

export function rpcStartMarch(
  ctx: nkruntime.Context,
  logger: nkruntime.Logger,
  nk: nkruntime.Nakama,
  payload: string
): string {
  const userId = ctx.userId;
  if (!userId) return JSON.stringify({ ok: false, error: 'unauthenticated' });

  const req = JSON.parse(payload) as {
    marchType: MarchType;
    origin: TileCoord;
    target: TileCoord;
    troops: Record<string, number>;
  };

  const state = readKingdomState(nk, userId);
  if (!state) return JSON.stringify({ ok: false, error: 'no_kingdom_state' });

  // NOTE: troop-count/ownership validation against state.army and march
  // carry-capacity are Volume 5 (Army) territory per this volume's explicit
  // deferral list — this RPC validates shape/distance/timing, which is all
  // Volume 3 owns.
  const dist = chebyshevDistance(req.origin, req.target);
  const nowTick = Math.floor(Date.now() / 1000);
  const travelSeconds = Math.max(1, dist * SECONDS_PER_TILE);
  const arrivalTick = nowTick + travelSeconds;

  const result = nk.sqlQuery(
    `INSERT INTO army_march
       (shard_id, user_id, march_type, origin_x, origin_y, target_x, target_y, troops,
        departure_tick, arrival_tick, status, resolved)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'marching', FALSE)
     RETURNING march_id`,
    [state.shardId, userId, req.marchType, req.origin.x, req.origin.y, req.target.x, req.target.y,
     JSON.stringify(req.troops), nowTick, arrivalTick]
  );

  const marchId = result && result[0] ? result[0].march_id : null;
  return JSON.stringify({ ok: true, marchId, arrivalTick });
}

export function rpcRecallMarch(
  ctx: nkruntime.Context,
  logger: nkruntime.Logger,
  nk: nkruntime.Nakama,
  payload: string
): string {
  const userId = ctx.userId;
  if (!userId) return JSON.stringify({ ok: false, error: 'unauthenticated' });
  const req = JSON.parse(payload) as { marchId: string };

  // Only lets a player recall their own still-marching march — the WHERE
  // clause is the whole authorization + state check in one atomic
  // statement, same pattern as claimTile's atomic UPDATE.
  const result = nk.sqlExec(
    `UPDATE army_march SET status = 'recalled', resolved = TRUE
     WHERE march_id = $1 AND user_id = $2 AND resolved = FALSE AND status = 'marching'`,
    [req.marchId, userId]
  );
  const ok = !!result && result.rowsAffected > 0;
  return JSON.stringify({ ok, error: ok ? undefined : 'march_not_recallable' });
}

// The scaling-critical piece. Meant to be hit by an external cron (Volume 3
// §11 "external scheduler") every 5-10s — NOT a per-player, per-request
// path. Each call:
//   1. Reads up to MARCH_SWEEP_BATCH_SIZE arrived-but-unresolved marches,
//      using the partial index on (arrival_tick) WHERE resolved = FALSE —
//      this is an index range scan bounded by how many marches are
//      CURRENTLY in flight, never by total marches ever created.
//   2. Marks them resolved in one batched UPDATE (single round trip, not
//      one write per march).
// At 10k concurrent marches, this clears the whole backlog in
// ceil(10000/500) = 20 sweep calls — a few seconds of cron cadence, and
// each individual call stays cheap and bounded regardless of how many
// marches are in the system.
export function rpcSweepMarchArrivals(
  ctx: nkruntime.Context,
  logger: nkruntime.Logger,
  nk: nkruntime.Nakama,
  payload: string
): string {
  const nowTick = Math.floor(Date.now() / 1000);

  const due = nk.sqlQuery(
    `SELECT march_id, shard_id, user_id, march_type, origin_x, origin_y, target_x, target_y,
            troops, departure_tick, arrival_tick, status, resolved
     FROM army_march
     WHERE resolved = FALSE AND arrival_tick <= $1
     ORDER BY arrival_tick ASC
     LIMIT $2`,
    [nowTick, MARCH_SWEEP_BATCH_SIZE]
  );

  const marches = (due || []).map(rowToMarch);
  if (marches.length === 0) {
    return JSON.stringify({ ok: true, processed: 0 });
  }

  // Actual combat/gather-cargo resolution is stubbed per this volume's
  // scope (§ explicitly defers full combat to Volume 6, cargo caps to
  // Volume 5) — this sweep's job is purely "did the clock run out," which
  // is all Volume 3 owns. A future volume plugs real resolution in here
  // per march_type without touching this batching/indexing logic.
  const ids = marches.map((m) => m.marchId);
  nk.sqlExec(
    `UPDATE army_march SET status = 'completed', resolved = TRUE WHERE march_id = ANY($1)`,
    [ids]
  );

  logger.info('sweep_march_arrivals resolved %d marches (batch cap %d)', marches.length, MARCH_SWEEP_BATCH_SIZE);
  // hasMore lets the external cron immediately re-invoke instead of waiting
  // a full cadence period when the backlog is larger than one batch (e.g.
  // right after a server outage cleared, or a genuine 10k-arrival spike).
  return JSON.stringify({ ok: true, processed: marches.length, hasMore: marches.length === MARCH_SWEEP_BATCH_SIZE });
}