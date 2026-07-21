// modules/main.ts
import { afterAuthenticate } from './auth/hooks';
import { rpcUpgradeBuilding } from './economy/buildings';
import { rpcGetFullState } from './economy/get_full_state';
import { rpcPlaceBuilding } from './economy/placement';
import { rpcAdminCleanupBuildings } from './economy/admin_cleanup';
import { rpcGetWorldView } from './worldmap/tiles';
import { rpcStartMarch, rpcRecallMarch, rpcSweepMarchArrivals } from './worldmap/marches';
import { rpcTeleportCastle } from './worldmap/teleport';
import { rpcAcquireHero, rpcGetHeroRoster, rpcLevelUpHero, rpcAscendHero } from './heroes/roster';
import { rpcEquipItem, rpcUnequipItem } from './heroes/equipment';
import { rpcChangeFaction } from './heroes/factions';

const InitModule: nkruntime.InitModule = function (
  ctx: nkruntime.Context,
  logger: nkruntime.Logger,
  nk: nkruntime.Nakama,
  initializer: nkruntime.Initializer
) {
  // Auth hooks fire for every supported login method (§6.1). Registering the
  // same handler against all of them keeps new-player-init/offline-resolve
  // logic in one place rather than duplicated per auth method.
  initializer.registerAfterAuthenticateDevice(afterAuthenticate);
  initializer.registerAfterAuthenticateEmail(afterAuthenticate);
  initializer.registerAfterAuthenticateGoogle(afterAuthenticate);
  initializer.registerAfterAuthenticateApple(afterAuthenticate);

  initializer.registerRpc('get_full_state', rpcGetFullState);
  initializer.registerRpc('upgrade_building', rpcUpgradeBuilding);
  initializer.registerRpc('place_building',rpcPlaceBuilding)
  // One-time admin repair for the duplicate-castle / orphan-building bug.
  // Lock this down to admin-only callers before deploying, and it can be
  // unregistered again once the cleanup sweep has been run.
  initializer.registerRpc('admin_cleanup_buildings', rpcAdminCleanupBuildings)

  // Volume 3: World Map
  initializer.registerRpc('get_world_view', rpcGetWorldView);
  initializer.registerRpc('start_march', rpcStartMarch);
  initializer.registerRpc('recall_march', rpcRecallMarch);
  initializer.registerRpc('teleport_castle', rpcTeleportCastle);
  // Not meant to be called by game clients — hit by an external cron
  // (e.g. a scheduled curl from docker-compose or a k8s CronJob) every
  // 5-10s. Lock this down (admin key / internal-network-only) before
  // deploying anywhere clients can reach it directly, same caution as
  // admin_cleanup_buildings above.
  initializer.registerRpc('sweep_march_arrivals', rpcSweepMarchArrivals);

  // Volume 4: Heroes (customized — faction-mirrored roster, see heroes/*.ts)
  initializer.registerRpc('get_hero_roster', rpcGetHeroRoster);
  initializer.registerRpc('acquire_hero', rpcAcquireHero);
  initializer.registerRpc('level_up_hero', rpcLevelUpHero);
  initializer.registerRpc('ascend_hero', rpcAscendHero);
  initializer.registerRpc('equip_item', rpcEquipItem);
  initializer.registerRpc('unequip_item', rpcUnequipItem);
  // Custom addition beyond the original Vol4 doc — lets a player spend a
  // faction_change_card item to switch factions (§ discussed with user).
  initializer.registerRpc('change_faction', rpcChangeFaction);

  logger.info('Storm MMORTS Volume 1 modules loaded');
};

// Nakama's JS VM looks up "InitModule" as a global identifier at startup.
// esbuild's bundler tree-shakes unexported top-level bindings that have no
// real side effect, and a bare reference like "!InitModule && InitModule;"
// does NOT count as a side effect — esbuild removes it, and with it the
// whole InitModule declaration, leaving an empty bundle. Assigning it onto
// the global object below IS a side-effecting statement, so esbuild keeps
// it, and it's also what actually exposes InitModule globally for Nakama
// to find (a top-level "const"/"let" in a CJS bundle does not attach to
// globalThis on its own).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).InitModule = InitModule;