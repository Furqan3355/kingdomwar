// modules/auth/hooks.ts
import { KingdomState, KINGDOM_COLLECTION, KINGDOM_KEY } from '../types';
import { getLowestPopulationOpenShard } from '../config/loader';
import { readKingdomState, writeKingdomState, readAndResolveKingdomState } from '../economy/resources';
import { completeFinishedUpgrades } from '../economy/buildings';
import { CURRENT_STATE_VERSION } from "../economy/version";
import { claimTile } from '../worldmap/tiles';

// Registered against every authenticateX hook in main.ts. Runs for both
// new and returning players — branches on whether kingdom state exists.
export function afterAuthenticate(
  ctx: nkruntime.Context,
  logger: nkruntime.Logger,
  nk: nkruntime.Nakama,
  data: any
): void {
  const userId = ctx.userId;
  if (!userId) {
    logger.error('afterAuthenticate fired with no ctx.userId — skipping kingdom init/resolve');
    return;
  }

  const existing = readKingdomState(nk, userId);

  if (!existing) {
    initializeNewPlayer(nk, logger, userId);
    return;
  }

  // Returning player: resolve offline progress (lazy resource resolve +
  // completing any upgrades that finished while away) so the client's next
  // get_full_state call reflects reality without a separate round trip.
  const resolved = readAndResolveKingdomState(nk, userId);
  const completed = completeFinishedUpgrades(resolved);
  writeKingdomState(nk, userId, completed);

  // Volume 3 backfill: accounts created before this volume shipped have a
  // KingdomState but never got a world_tile row. Cheap indexed lookup
  // (idx_world_tile_owner) every login is fine — it's a single index hit,
  // not a scan — and self-heals every pre-existing account the first time
  // they log in after this deploy, no separate migration script needed.
  if (!hasWorldMapCastle(nk, completed.shardId, userId)) {
    claimStartingWorldTile(nk, logger, completed.shardId, userId);
    logger.info('backfilled Volume 3 world-map castle tile for existing player %s', userId);
  }
}

function hasWorldMapCastle(nk: nkruntime.Nakama, shardId: number, userId: string): boolean {
  const result = nk.sqlQuery(
    `SELECT 1 FROM world_tile WHERE shard_id = $1 AND owner_user_id = $2 AND tile_type = 'player_castle' LIMIT 1`,
    [shardId, userId]
  );
  return !!result && result.length > 0;
}

function claimStartingWorldTile(nk: nkruntime.Nakama, logger: nkruntime.Logger, shardId: number, userId: string): void {
  const spawnCoord = findSpawnTileNearNewbieZone(nk, shardId);
  const claimed = claimTile(nk, shardId, spawnCoord, { tileType: 'player_castle', ownerUserId: userId });
  if (!claimed) {
    logger.error('failed to claim world tile for %s at %d,%d', userId, spawnCoord.x, spawnCoord.y);
  }
}

function initializeNewPlayer(
  nk: nkruntime.Nakama,
  logger: nkruntime.Logger,
  userId: string
): void {
  const shardId = getLowestPopulationOpenShard(nk);

  // 0005 redesign: starter roster is Castle + 3 Storages + Builder Hut +
  // Summon Hut, placed at fixed non-overlapping coordinates (generous gaps,
  // well over the 1-tile buffer minimum). Castle/Builder Hut/Summon Hut
  // start already built at level 1 (their level-1 config is free/instant,
  // same pattern as Volume 1's original starting castle). Storages start
  // placed but unbuilt (level 0) — the player upgrades them like any other
  // building. Every other building (Barracks, defense structures, etc.) is
  // NOT in the starting roster at all — per the new "shop" model, the
  // player must unlock (castle level) AND place (place_building RPC) them
  // manually; nothing is auto-placed on their behalf.
  const startingState: KingdomState = {
    userId,
    shardId,
     stateVersion: CURRENT_STATE_VERSION,
    castleLevel: 1,
    buildings: {
      'castle:2_12':        { buildingId: 'castle',        slot: '2_12', level: 1, upgradeFinishTick: null },
      'builder_hut:2_7':     { buildingId: 'builder_hut',   slot: '2_7',  level: 1, upgradeFinishTick: null },
      'summon_hut:7_7':      { buildingId: 'summon_hut',    slot: '7_7',  level: 1, upgradeFinishTick: null },
      'gold_storage:2_2':    { buildingId: 'gold_storage',  slot: '2_2',  level: 0, upgradeFinishTick: null },
      'crystal_storage:7_2': { buildingId: 'crystal_storage', slot: '7_2', level: 0, upgradeFinishTick: null },
      'mithril_storage:12_2':{ buildingId: 'mithril_storage', slot: '12_2', level: 0, upgradeFinishTick: null },
    },
    resources: { gold: 500, crystal: 100, mithril: 0 },
    lastCalculatedTick: Math.floor(Date.now() / 1000),
    army: {},
    researchLevels: {},
    allianceId: null,
    displayName: `Warlord${userId.substring(0, 6)}`,
    power: 0,
  };

  writeKingdomState(nk, userId, startingState);

  nk.sqlExec(
    `INSERT INTO player_shard_membership (user_id, shard_id) VALUES ($1, $2)
     ON CONFLICT DO NOTHING`,
    [userId, shardId]
  );

  // Volume 3 §8.2/§8.3: claim a starting world-map castle tile in a
  // low-contention newbie zone. §8.3's protection window
  // (protectionExpiresTick) is a KingdomState field for a later volume's
  // attack-validation path to enforce — not implemented here, this hook
  // only owns placement.
  claimStartingWorldTile(nk, logger, shardId, userId);

  logger.info('initialized new player %s on shard %d', userId, shardId);
}

// §8.3: new players spawn near map edges (deliberately low-contention —
// established players cluster toward the center over a shard's lifetime).
// Samples random points in an edge band and retries against empty tiles;
// bounded attempts so this can never hang even if a shard's edges are
// unexpectedly saturated.
function findSpawnTileNearNewbieZone(nk: nkruntime.Nakama, shardId: number) {
  const GRID = 1024;
  const EDGE_BAND = 64; // how deep the "newbie zone" band is from each edge
  for (let attempt = 0; attempt < 40; attempt++) {
    const onXEdge = Math.random() < 0.5;
    const x = onXEdge
      ? Math.floor(Math.random() * EDGE_BAND) + (Math.random() < 0.5 ? 0 : GRID - EDGE_BAND)
      : Math.floor(Math.random() * GRID);
    const y = onXEdge
      ? Math.floor(Math.random() * GRID)
      : Math.floor(Math.random() * EDGE_BAND) + (Math.random() < 0.5 ? 0 : GRID - EDGE_BAND);

    const existing = nk.sqlQuery(
      `SELECT 1 FROM world_tile WHERE shard_id = $1 AND x = $2 AND y = $3 AND tile_type <> 'empty'`,
      [shardId, x, y]
    );
    if (!existing || existing.length === 0) return { x, y };
  }
  // Fallback: pure random anywhere on the grid, better than failing signup entirely.
  return { x: Math.floor(Math.random() * GRID), y: Math.floor(Math.random() * GRID) };
}