// modules/army/reinforcement.ts
// Volume 5 §4, per confirmed design: reinforcement is only possible on
// Temple / Fortress / Citadel world-map structures (never a plain
// player_castle). "Automatic" per the design notes means the RECEIVING
// structure automatically accepts/holds any reinforcement sent to it (no
// approval step) — it does NOT mean troops auto-march there on their own;
// the player still explicitly sends them via this RPC. Command Centre
// (mentioned in the design chat as a future gate on this) does not exist
// yet as a building — this stays unconditional until that lands.

import { getTile } from '../worldmap/tiles';
import { readAndResolveKingdomState, writeKingdomState } from '../economy/resources';
import { computeSlotsUsed } from './formation';

const REINFORCE_SLOT_CAP = 300; // design constant — max slots a single structure garrison can hold, tune later

export function rpcSendReinforcement(
  ctx: nkruntime.Context,
  logger: nkruntime.Logger,
  nk: nkruntime.Nakama,
  payload: string
): string {
  const userId = ctx.userId;
  if (!userId) return respond({ ok: false, error: 'unauthenticated' });

  let req: { x: number; y: number; troops: Record<string, number> };
  try {
    req = JSON.parse(payload);
  } catch (e) {
    return respond({ ok: false, error: 'invalid_payload' });
  }
  if (req.x === undefined || req.y === undefined || !req.troops) {
    return respond({ ok: false, error: 'missing_target_or_troops' });
  }

  const state = readAndResolveKingdomState(nk, userId);

  const tile = getTile(nk, state.shardId, { x: req.x, y: req.y });
  if (!tile || (tile.tileType !== 'temple' && tile.tileType !== 'fortress' && tile.tileType !== 'citadel')) {
    return respond({ ok: false, error: 'not_reinforceable_target' });
  }

  // Validate the player actually owns enough garrisoned troops to send.
  for (const unitId in req.troops) {
    const want = req.troops[unitId];
    if (!want || want <= 0) continue;
    const have = state.army[unitId] || 0;
    if (have < want) return respond({ ok: false, error: `insufficient_troops:${unitId}` });
  }

  const sendSlots = computeSlotsUsed(nk, req.troops);
  const existingGarrisonSlots = getGarrisonSlotsAtTile(nk, state.shardId, req.x, req.y);
  if (existingGarrisonSlots + sendSlots > REINFORCE_SLOT_CAP) {
    return respond({ ok: false, error: 'structure_garrison_full' });
  }

  // Deduct from home garrison and write straight into the structure's
  // garrison table. NOTE: unlike world-map attack/gather marches (Volume
  // 3), reinforcement travel time is intentionally NOT modeled here —
  // Volume 3's march system already owns "marching between tiles"; wiring
  // reinforcement through army_march as its own march_type is a natural
  // follow-up but is out of this volume's scope per the design chat
  // (reinforcement was discussed as "automatic", i.e. instant-hold once
  // sent, not as a new travel-time mechanic).
  for (const unitId in req.troops) {
    const want = req.troops[unitId];
    if (!want || want <= 0) continue;
    state.army[unitId] -= want;
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  const existing = nk.sqlQuery(
    `SELECT troops FROM structure_garrison WHERE shard_id = $1 AND x = $2 AND y = $3 AND user_id = $4`,
    [state.shardId, req.x, req.y, userId]
  );
  const mergedTroops: Record<string, number> = (existing && existing[0]) ? existing[0].troops : {};
  for (const unitId in req.troops) {
    mergedTroops[unitId] = (mergedTroops[unitId] || 0) + req.troops[unitId];
  }

  nk.sqlExec(
    `INSERT INTO structure_garrison (shard_id, x, y, user_id, troops, sent_tick)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (shard_id, x, y, user_id) DO UPDATE SET
       troops = $5, sent_tick = $6`,
    [state.shardId, req.x, req.y, userId, JSON.stringify(mergedTroops), nowSeconds]
  );

  writeKingdomState(nk, userId, state);

  return respond({ ok: true, army: state.army });
}

export function rpcRecallReinforcement(
  ctx: nkruntime.Context,
  logger: nkruntime.Logger,
  nk: nkruntime.Nakama,
  payload: string
): string {
  const userId = ctx.userId;
  if (!userId) return respond({ ok: false, error: 'unauthenticated' });
  const req = JSON.parse(payload) as { x: number; y: number };

  const state = readAndResolveKingdomState(nk, userId);

  const result = nk.sqlQuery(
    `SELECT troops FROM structure_garrison WHERE shard_id = $1 AND x = $2 AND y = $3 AND user_id = $4`,
    [state.shardId, req.x, req.y, userId]
  );
  if (!result || result.length === 0) return respond({ ok: false, error: 'no_garrison_here' });

  const troops = result[0].troops as Record<string, number>;
  for (const unitId in troops) {
    state.army[unitId] = (state.army[unitId] || 0) + troops[unitId];
  }

  nk.sqlExec(
    `DELETE FROM structure_garrison WHERE shard_id = $1 AND x = $2 AND y = $3 AND user_id = $4`,
    [state.shardId, req.x, req.y, userId]
  );

  writeKingdomState(nk, userId, state);

  return respond({ ok: true, army: state.army });
}

function getGarrisonSlotsAtTile(nk: nkruntime.Nakama, shardId: number, x: number, y: number): number {
  const result = nk.sqlQuery(
    `SELECT troops FROM structure_garrison WHERE shard_id = $1 AND x = $2 AND y = $3`,
    [shardId, x, y]
  );
  let total = 0;
  for (const row of result || []) {
    total += computeSlotsUsed(nk, row.troops as Record<string, number>);
  }
  return total;
}

function respond(res: any): string {
  return JSON.stringify(res);
}