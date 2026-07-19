# Storm MMORTS — Volume 1 Implementation

Reference implementation of **Volume 1 (Core Architecture) + Volume 2 (City
System)** from the TDD. Covers: Nakama/Postgres backend, auth + new-player
init, lazy resource resolve with storage-cap clamping, the full starting
production roster (Gold/Crystal/Mithril Factory + Storage, Castle),
slot-binding + prerequisite validation, the config export pipeline, and a
Unity client scaffold (Boot → City flow).

## What's here

```
storm-mmorts/
├── docker-compose.yml
├── nakama/
│   ├── package.json / tsconfig.json
│   └── modules/
│       ├── main.ts                  (registers hooks + RPCs)
│       ├── types.ts                 (KingdomState, BuildingInstance, ...)
│       ├── auth/hooks.ts            (afterAuthenticate, new player init)
│       ├── config/loader.ts         (Postgres config reads)
│       └── economy/
│           ├── resources.ts         (lazy production resolve)
│           ├── buildings.ts         (upgrade_building RPC)
│           └── get_full_state.ts    (aggregated session-start RPC)
├── postgres/migrations/0001_init.sql
├── tools/
│   ├── apply_custom_migrations.sh
│   ├── export_config.js             (ScriptableObject-JSON -> SQL)
│   └── sample-config.json
└── unity/Assets/_Project/Scripts/
    ├── Core/Services.cs
    ├── Networking/NakamaClientService.cs
    ├── Data/KingdomModels.cs, PlayerDataService.cs
    └── Boot/BootController.cs
```

## Running the backend

```bash
cd nakama
npm install
npm run build          # bundles modules/main.ts -> build/index.js

cd ..
docker compose up -d   # starts postgres + nakama

# Nakama's own migrate step runs automatically on container start.
# Custom tables (building_config etc.) need a separate apply, since
# `nakama migrate up` only manages Nakama's own schema. This applies
# BOTH migrations in order (0001_init.sql + 0002_city_system.sql):
./tools/apply_custom_migrations.sh
```

Nakama console: http://127.0.0.1:7351 (default credentials: admin/password —
**change before anything beyond local dev**).

## Testing the Volume 1 loop without Unity (curl only, no Postman needed)

Run the automated script:
```bash
./tools/test_server_curl.sh
```
This does everything below automatically and prints each response. Or run the
steps manually yourself:

1. Authenticate a device:
   ```bash
   curl "http://127.0.0.1:7350/v2/account/authenticate/device?create=true" \
     -u "defaultkey:" \
     -H "Content-Type: application/json" \
     -d '{"id": "test-device-1"}'
   ```
   Copy the `"token"` value from the response — you'll need it for every call below.
2. Call `get_full_state` (replace `$TOKEN` with the token from step 1):
   ```bash
   curl "http://127.0.0.1:7350/v2/rpc/get_full_state?unwrap" \
     -H "Authorization: Bearer $TOKEN" \
     -H "Content-Type: application/json" \
     -d '{}'
   ```
   Should return a fresh `KingdomState` with 500 gold, 100 crystal, 0 mithril, no buildings.
3. Call `upgrade_building`:
   ```bash
   curl "http://127.0.0.1:7350/v2/rpc/upgrade_building?unwrap" \
     -H "Authorization: Bearer $TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"buildingId": "gold_factory", "slot": "1_1"}'
   ```
   Should succeed (level 1 costs 0 in the seed data) and return a building
   with a non-null `upgradeFinishTick`.
4. Call `upgrade_building` again with the same payload — should return
   `already_upgrading`.
5. Wait 30s (seed data's level-1 upgrade time), call `get_full_state` again —
   the building should now show `level: 1, upgradeFinishTick: null`.

**Tip on the `?unwrap` query param:** without it, Nakama expects the RPC
payload to be a JSON-encoded *string* inside the request body (double-encoded
JSON), and returns the response the same way. Adding `?unwrap` to the URL
lets you send/receive plain JSON directly — much easier to read and type by
hand with curl.

## Regenerating config from the sample designer JSON

```bash
node tools/export_config.js tools/sample-config.json > /tmp/config-update.sql
PGPASSWORD=localdev psql "postgresql://nakama@localhost:5432/nakama?sslmode=disable" -f /tmp/config-update.sql
```

This is the CLI half of the pipeline in TDD §9.2. The Unity-editor half (an
`AssetPostprocessor`/menu-item script that walks `BuildingConfig`
ScriptableObjects and writes `sample-config.json`'s shape) is not included
in this scaffold — it's pure Unity-editor glue with no server implications,
and is a reasonable next task once real ScriptableObject definitions exist
in Volume 2.

## Unity setup notes

- Requires the **Nakama Unity SDK** (`com.heroiclabs.nakama-unity`, via
  Package Manager git URL or `.unitypackage`) and **Newtonsoft Json**
  (`com.unity.nuget.newtonsoft-json`) — the latter is required because
  `JsonUtility` cannot deserialize the `Dictionary` fields on `KingdomState`.
- Create a `Boot` scene, add an empty GameObject with `BootController`
  attached, and set it as the first scene in Build Settings.
- `City` and `Login` scenes referenced by `BootController` are stubs to be
  filled in starting Volume 2 (City System) — this scaffold only needs them
  to exist for `SceneManager.LoadScene` to resolve.

## Volume 1 definition-of-done — status

- [x] `docker compose up` brings up Nakama + Postgres with migrations
- [x] Custom migrations applied via `apply_custom_migrations.sh`
- [x] Guest device-ID login creates a new player with correct starter state
      (`auth/hooks.ts::initializeNewPlayer`)
- [x] Second login triggers offline-progress resolution, not re-init
      (`auth/hooks.ts::afterAuthenticate` branch)
- [x] `get_full_state` returns kingdom + army + heroes + alliance
      (stubs for army/heroes/alliance until their volumes land, matching
      the response shape those volumes will fill in)
- [x] `gold_factory` cost/timer round-trips: seed data → `upgrade_building`
      RPC validates against it → client displays the same numbers
- [x] No client code path mutates resource/troop/building state without a
      server RPC (`PlayerDataService` only ever writes `Kingdom.*` from RPC
      responses or as optimistic timer display, never resource totals)

## Known gaps / explicitly deferred (do not scope-creep into Volume 2 territory)

- Only one building (`gold_factory`) is seeded — full building roster is
  Volume 2.
- `power` field exists on `KingdomState` but nothing recalculates it yet —
  no system that touches power (army, heroes) exists until later volumes.
- Google/Apple auth hook registrations exist in `main.ts` but the actual
  client-side Google/Apple SDK integration is not included — device-ID auth
  is enough to validate the whole Volume 1 loop.
- No automated test suite is included in this scaffold. Recommended next
  step before Volume 2: a small Jest/ts-node harness that calls the RPC
  functions directly with a mocked `nk`/`ctx`, covering the scenarios in
  "Testing the Volume 1 loop" above.
