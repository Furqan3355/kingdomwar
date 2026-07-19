// modules/auth/hooks.ts
import { KingdomState, KINGDOM_COLLECTION, KINGDOM_KEY } from '../types';
import { getLowestPopulationOpenShard } from '../config/loader';
import { readKingdomState, writeKingdomState, readAndResolveKingdomState } from '../economy/resources';
import { completeFinishedUpgrades } from '../economy/buildings';

// Registered against every authenticateX hook in main.ts. Runs for both
// new and returning players — branches on whether kingdom state exists.
export function afterAuthenticate(
  ctx: nkruntime.Context,
  logger: nkruntime.Logger,
  nk: nkruntime.Nakama,
  data: any
): void {
  const userId = ctx.userId;
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
}

function initializeNewPlayer(
  nk: nkruntime.Nakama,
  logger: nkruntime.Logger,
  userId: string
): void {
  const shardId = getLowestPopulationOpenShard(nk);

  const startingState: KingdomState = {
    userId,
    shardId,
    castleLevel: 1,
    // Volume 2 §9: the Castle building instance and castleLevel must start
    // in sync — 0002_city_system.sql seeds castle level 1 as free/instant, so
    // the new player begins already "built" at level 1, not mid-construction.
    buildings: {
      'castle:4_4': {
        buildingId: 'castle',
        slot: '4_4',
        level: 1,
        upgradeFinishTick: null,
      },
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

  logger.info('initialized new player %s on shard %d', userId, shardId);
}
