// modules/auth/hooks.ts
import { KingdomState, KINGDOM_COLLECTION, KINGDOM_KEY } from '../types';
import { getLowestPopulationOpenShard } from '../config/loader';
import { readKingdomState, writeKingdomState, readAndResolveKingdomState } from '../economy/resources';
import { completeFinishedUpgrades } from '../economy/buildings';
import { CURRENT_STATE_VERSION } from "../economy/version";

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

  logger.info('initialized new player %s on shard %d', userId, shardId);
}