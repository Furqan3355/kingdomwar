// modules/main.ts
import { afterAuthenticate } from './auth/hooks';
import { rpcUpgradeBuilding } from './economy/buildings';
import { rpcGetFullState } from './economy/get_full_state';
import { rpcPlaceBuilding } from './economy/placement';

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