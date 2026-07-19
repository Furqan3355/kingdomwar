# Storm of Wars–Inspired MMORTS
## Technical Design Document — Volume 3: World Map
### Unity + Nakama

*Builds on Volume 1 (Nakama storage patterns, RPC/match-handler boundary, optimistic concurrency) and Volume 2 (Castle as the anchor building). This volume defines the shared, persistent world grid all players on a shard interact with — the first system in this TDD that is genuinely multi-player-scoped rather than per-player.*

---

## 1. Coordinate System

### 1.1 Grid shape
A single **square grid per shard**, addressed by integer `(x, y)`. Recommended launch size: **1024×1024** — large enough that early-game players don't feel crowded, small enough that travel times stay meaningful without needing a second coordinate layer (regions/continents can be a Volume 3.5 addition if launch data shows the grid feels too sparse or too dense).

```typescript
// modules/worldmap/types.ts
export interface TileCoord {
  x: number; // 0..1023
  y: number; // 0..1023
}

export function tileKey(coord: TileCoord): string {
  return `${coord.x}_${coord.y}`;
}

export function distance(a: TileCoord, b: TileCoord): number {
  // Chebyshev distance — standard for grid-based MMORTS march timing,
  // since diagonal movement isn't slower than orthogonal on a world map.
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}
```

### 1.2 Why Chebyshev, not Euclidean
Euclidean distance would make diagonal marches "cheaper" per tile than the client's grid rendering suggests, creating an exploit where players path diagonally to minimize march time. Chebyshev distance (`max(dx, dy)`) matches 8-directional grid movement intuition and removes that exploit entirely — it's a one-line formula choice with real balance implications, so it's called out explicitly rather than left as an implementation detail.

### 1.3 Region subdivision (for query performance, not gameplay)
Even though gameplay treats the grid as one continuous space, tile storage is logically chunked into **32×32 regions** purely so common queries ("what's near me," "render the visible viewport") don't scan the whole shard:

```typescript
export function regionKey(coord: TileCoord): string {
  return `${Math.floor(coord.x / 32)}_${Math.floor(coord.y / 32)}`;
}
```

This region key becomes part of the storage collection design in Section 2 — it's a query optimization, not a player-facing concept.

---

## 2. World Grid System & Tile Storage

### 2.1 Storage model
World tiles are **shard-global data**, not per-player — this is the first system in the TDD where the Volume 1 "per-player blob → Nakama storage, keyed by userId" pattern doesn't apply directly. Instead:

```typescript
// modules/worldmap/tiles.ts
export interface WorldTile {
  x: number;
  y: number;
  shardId: number;
  tileType: 'empty' | 'resource_node' | 'player_castle' | 'neutral_monster' | 'boss_monster' | 'alliance_territory';
  ownerUserId: string | null;
  ownerAllianceId: string | null;
  occupantData: any; // shape depends on tileType — see Sections 4/5/8
  lastUpdatedTick: number;
  version: string; // Nakama storage version, for optimistic concurrency (§2.3)
}
```

**Collection design:** store tiles under a storage collection with **no `userId`** (Nakama supports a `null`/system-owned userId for genuinely shared objects), keyed by `${shardId}:${regionKey}:${tileKey}` so a viewport query can list-by-prefix on `${shardId}:${regionKey}` and get roughly one region's worth of tiles per call.

```typescript
export function tileStorageKey(shardId: number, coord: TileCoord): string {
  return `${shardId}:${regionKey(coord)}:${tileKey(coord)}`;
}
```

### 2.2 Why not a live Nakama match for the whole map
A tempting-but-wrong design is "the world map is one giant match everyone joins." This doesn't scale — Nakama match handlers run single-threaded per match instance, and a shard-wide map with thousands of concurrent players would serialize all tile reads/writes through one goroutine. Tiles are read/written via **RPCs against storage**, with match handlers reserved only for genuinely time-boxed multi-party events (rally battles at a specific tile — Volume 6 territory, boss fights — Section 5.3).

### 2.3 Concurrency: claiming a tile
Two players attacking the same neutral monster or claiming the same resource node simultaneously is the core race condition this system must handle correctly. Nakama storage writes support **optimistic concurrency via version tokens** — use them on every tile mutation:

```typescript
export function claimTile(nk: nkruntime.Nakama, key: string, mutate: (tile: WorldTile) => WorldTile): boolean {
  const existing = nk.storageRead([{ collection: 'world_tile', key, userId: '' }]);
  if (!existing || existing.length === 0) return false;

  const tile = existing[0].value as WorldTile;
  const updated = mutate(tile);

  try {
    nk.storageWrite([{
      collection: 'world_tile',
      key,
      userId: '',
      value: updated,
      version: existing[0].version, // rejects if another write happened since our read
      permissionRead: 2,  // public read — all players can see tile state
      permissionWrite: 0, // server-only write
    }]);
    return true;
  } catch (e) {
    // Version mismatch — someone else claimed it first. Caller should
    // re-read and retry once, then surface "already claimed" to the client
    // rather than retrying indefinitely (avoid livelock under contention).
    return false;
  }
}
```

**Rule for every RPC in this volume:** never read-modify-write a tile without passing the version token through, per this pattern. A blind overwrite is how two guilds "both win" the same tile — the exact bug Volume 1's rules document calls out generically in §17.

---

## 3. Tile Ownership

### 3.1 Ownership types
| `tileType` | Owner field used | Set by |
|---|---|---|
| `player_castle` | `ownerUserId` | Player relocates/founds their castle (Section 9) |
| `alliance_territory` | `ownerAllianceId` | Alliance territory claim (Volume 7 — hook only in this volume) |
| `resource_node` | `ownerUserId` (temporary, while being gathered) | Section 4 |
| `neutral_monster` / `boss_monster` | none (always neutral until defeated) | N/A |
| `empty` | none | Default state |

### 3.2 Ownership transfer RPC
```typescript
export function rpcClaimTile(ctx, logger, nk, payload) {
  const req = JSON.parse(payload); // { x, y }
  const key = tileStorageKey(getPlayerShardId(nk, ctx.userId), req);

  const success = claimTile(nk, key, (tile) => {
    if (tile.tileType !== 'empty') {
      throw Error('tile_not_claimable');
    }
    tile.tileType = 'player_castle';
    tile.ownerUserId = ctx.userId;
    tile.lastUpdatedTick = Math.floor(Date.now() / 1000);
    return tile;
  });

  return JSON.stringify({ ok: success });
}
```

---

## 4. Resource Nodes

### 4.1 Concept
World-map tiles that, once claimed/occupied by a player's gathering army, produce resources over time — distinct from city-based production buildings (Volume 2). This is the primary reason to leave one's castle defenses thinner (risk/reward), a core MMORTS tension.

### 4.2 Data shape (`occupantData` for `tileType = 'resource_node'`)
```typescript
interface ResourceNodeData {
  resourceType: 'gold' | 'crystal' | 'mithril';
  totalCapacity: number;      // node depletes and disappears at 0
  remainingCapacity: number;
  gatherRate: number;         // per second, per gathering army present
  gatheringUserId: string | null;
  gatheringStartTick: number | null;
}
```

### 4.3 Gathering lifecycle
1. Player sends an army to gather (Section 6 — march system) with `marchType: 'gather'`.
2. On arrival, server claims the node (`gatheringUserId` set, version-checked per §2.3).
3. Node depletion is **lazy-resolved** on read, same pattern as city resource production (Volume 1 §5): `remainingCapacity -= elapsed * gatherRate` computed when the node is next read, not via a scheduled job.
4. When a player recalls their army or the node hits 0 capacity, gathered resources are added to the army's carried cargo (capped by troop carry capacity — Volume 5), then transferred to the player's `KingdomState.resources` on the army's return march completion.

### 4.4 Node respawn
Depleted nodes are removed from `world_tile` (reverted to `tileType: 'empty'`) and a scheduled external job (same mechanism as Volume 1 §4.4's cron pattern) periodically reseeds a target density of resource nodes per region, weighted toward `gold` nodes near the map edges (low-level player spawn areas) and higher-value `mithril` nodes toward the center (contested late-game territory) — a standard MMORTS map-shaping technique that naturally funnels PvP conflict toward the center as players grow.

---

## 5. Neutral Monsters & Boss Monsters

### 5.1 Neutral monsters
World-map PvE targets with fixed stat tiers, attackable by a single player's army without a live match (uses the same async-combat RPC pattern established for base attacks — this volume just adds monsters as a valid attack target type alongside player castles).

```typescript
interface MonsterData {
  monsterTier: number;        // 1-10, gates rewards and difficulty
  troops: Record<string, number>; // defender composition, same shape as player army
  rewardTable: string;        // reference into a loot table config (Volume 2-style config table)
  respawnSeconds: number;
}
```

Attacking a neutral monster reuses Volume 1's combat philosophy directly: single RPC (`attack_tile`), server loads monster composition, resolves combat via the shared resolver (to be defined fully in Volume 6, stubbed here), writes a battle report, and — on victory — removes the monster tile and schedules a respawn.

### 5.2 Boss monsters — why they're different
Boss monsters are intentionally **too strong for one player's army**, forcing multi-party participation — this is where the live-match pattern from Volume 1 §2.3/§7B (reserved for genuinely time-boxed multi-party state) actually applies on the world map:

```typescript
// modules/worldmap/boss_match.ts
const bossMatchHandler: nkruntime.MatchHandler = {
  matchInit: (ctx, logger, nk, params) => {
    // params.tileKey identifies which boss tile this match resolves
    const state = { tileKey: params.tileKey, joinedArmies: {}, rallyEndTick: nowSeconds() + 60 };
    return { state, tickRate: 1, label: `boss:${params.tileKey}` };
  },
  matchJoin: (ctx, logger, nk, dispatcher, tick, state, presences) => {
    // Validate each joining player has a valid army march targeting this tile
    // before accepting them into joinedArmies (§2.3-style validation applies
    // here too — trust nothing the client claims about its own army size).
    return { state };
  },
  matchLoop: (ctx, logger, nk, dispatcher, tick, state, messages) => {
    if (tick >= state.rallyEndTick) {
      resolveBossCombat(nk, state); // shared resolver, same as §5.1's single-player path
      dispatcher.matchLabelUpdate(`boss:${state.tileKey}:resolved`);
    }
    return state;
  },
  // matchTerminate, matchLeave, matchJoinAttempt, matchSignal — standard boilerplate
};
```

### 5.3 Boss spawn cadence
Boss tiles are seeded by the same external scheduler that handles resource-node respawn (Section 4.4) and Volume 1's daily-reset job — e.g. 1-3 boss spawns per shard per day, at coordinates broadcast via a world event (Section 10) so it functions as a rally point for alliance coordination.

---

## 6. March Paths

### 6.1 What a march is
A march is a **time-delayed, server-tracked movement of an army between two tiles** (or a tile and the player's own castle). It is not simulated tick-by-tick server-side for position — like building upgrades (Volume 1/2), it's represented as a start tick + duration + destination, resolved lazily.

```typescript
interface MarchState {
  marchId: string;
  userId: string;
  originCoord: TileCoord;
  destinationCoord: TileCoord;
  marchType: 'attack' | 'gather' | 'reinforce' | 'return' | 'scout';
  troops: Record<string, number>;
  departureTick: number;
  arrivalTick: number;
  status: 'marching' | 'arrived' | 'returning';
}
```

Stored in its own collection (`army_march`, per-player, keyed by `marchId`) — **not embedded in `KingdomState`**, matching the Volume 1 §7.3 rule that data with different write frequency/access pattern gets its own collection.

### 6.2 March duration formula
```
duration_seconds = distance(origin, destination) / march_speed
```
where `march_speed` (tiles/second) is derived from the slowest unit type in the marching army (standard MMORTS convention — a march moves at its slowest component's pace) plus any research/hero speed bonuses (hook only; those systems are Volumes 4/5).

### 6.3 Resolving arrival
Rather than a scheduled job firing exactly at `arrivalTick`, arrival is resolved **lazily on next relevant read** — same lazy-resolve philosophy used throughout this TDD:
- Any RPC that touches the player's armies (`get_full_state`, a new march request, opening the world map) first calls `resolveArrivedMarches(userId)`, which checks all `army_march` rows with `status = 'marching' AND arrivalTick <= now`, executes the arrival effect (start gathering, start combat, deliver reinforcements), and updates status.
- **Exception:** attacks against another *player's* tile should still push a notification (Volume 1's `nk.notificationSend`) at the moment of resolution, which does need a trigger — handled by the same external scheduler pattern (Volume 1 §4.4), running a periodic sweep (e.g. every 10s) that resolves any marches past their arrival tick, rather than waiting for the attacker's own next read. This ensures the *defender* finds out promptly even if the attacker never opens the app again.

### 6.4 Recall
A marching (not yet arrived) army can be recalled: server checks `status == 'marching' && now < arrivalTick`, flips `marchType` to `'return'`, recalculates `arrivalTick` based on distance already covered (`elapsed_fraction * total_distance` back to origin) — this prevents recall from being a free instant-abort exploit.

---

## 7. Fog of War

### 7.1 Design intent
Not full-map darkness (this is a strategic grid, not a rendered fog-of-war in the RTS-genre sense) — "fog of war" here means **information limits**, not visual occlusion:

| Information | Visible without action | Requires scouting |
|---|---|---|
| Tile occupied (yes/no) and `tileType` | Yes, always | — |
| Owner display name / alliance tag | Yes, always | — |
| Exact troop composition/count | No | Yes (Watch Tower / scout march) |
| Building layout inside a player's city | No | Yes, partial (scout reveals castle level + wall level only, not full building list) |

### 7.2 Scout march
A `marchType: 'scout'` march (Section 6) that, on arrival, doesn't fight — it grants the sender a time-limited (e.g. 1 hour) reveal of the target's troop composition and defense stats, stored as a per-player-pair record:

```typescript
interface ScoutReport {
  scoutingUserId: string;
  targetUserId: string;
  expiresTick: number;
  revealedTroops: Record<string, number>;
  revealedDefenseStats: any;
}
```

### 7.3 Watch Tower interaction (from Volume 2)
Volume 2 defined Watch Tower's `stat_value` as "scout detection radius" but deferred implementation. This volume completes that hook: an incoming march with `marchType: 'attack'` targeting a player whose Watch Tower level gives them detection ≥ the attacker's stealth (a stat reserved for hero/research bonuses in later volumes, defaulting to 0 for now) triggers an early-warning notification to the defender at, e.g., 50% of march duration elapsed rather than only on arrival.

---

## 8. Player Castles (on the world map)

### 8.1 Castle tile vs. Castle building
Volume 2's "Castle" building lives *inside* the city scene and represents city progression level. This section's "player castle" is the **world-map tile** representing where that city sits geographically — the anchor point all marches originate from and the tile that gets attacked when someone assaults the player directly rather than a resource node/monster. They're linked (one `KingdomState` has exactly one owned `tileType: 'player_castle'` tile) but are different objects with different lifecycles.

### 8.2 Castle placement on account creation
Volume 1's `initializeNewPlayer` (auth hook) currently only creates `KingdomState`. This volume extends that hook to also claim a starting world tile:

```typescript
// modules/auth/hooks.ts — extended in Volume 3
function initializeNewPlayer(nk, logger, userId: string): void {
  // ...existing KingdomState creation from Volume 1...
  const shardId = getLowestPopulationOpenShard(nk);
  const startCoord = findSpawnTileNearNewbieZone(nk, shardId); // Section 8.3
  claimTile(nk, tileStorageKey(shardId, startCoord), (tile) => {
    tile.tileType = 'player_castle';
    tile.ownerUserId = userId;
    return tile;
  });
}
```

### 8.3 Newbie zone placement
New players spawn in designated low-contention regions (map edges, per the resource-node density shaping in §4.4) with a **new-player protection window** (e.g. 72 hours, or until castle level 5, whichever first) during which their tile cannot be attacked — implemented as a simple field check (`protectionExpiresTick` on `KingdomState`) inside the attack-validation path, not a separate system.

---

## 9. Teleport System

### 9.1 Purpose
Lets an established player relocate their castle tile — either a limited free/cheap "random relocate within region" or a paid "teleport to specific coordinates" (monetization hook, full implementation in Volume 12).

### 9.2 RPC
```typescript
export function rpcTeleportCastle(ctx, logger, nk, payload) {
  const req = JSON.parse(payload); // { targetX?, targetY? } — omitted = random
  const userId = ctx.userId;
  const currentTile = getPlayerCastleTile(nk, userId);

  const target = req.targetX !== undefined
    ? { x: req.targetX, y: req.targetY }
    : findRandomEmptyTileNear(nk, currentTile, /* radius */ 50);

  const destKey = tileStorageKey(currentTile.shardId, target);
  const claimed = claimTile(nk, destKey, (tile) => {
    if (tile.tileType !== 'empty') throw Error('destination_occupied');
    tile.tileType = 'player_castle';
    tile.ownerUserId = userId;
    return tile;
  });
  if (!claimed) return JSON.stringify({ ok: false, error: 'destination_occupied' });

  // Vacate the old tile — same version-checked pattern, §2.3
  vacateTile(nk, tileStorageKey(currentTile.shardId, currentTile));

  return JSON.stringify({ ok: true, newCoord: target });
}
```

### 9.3 Safety constraints
- Reject teleport if the player has any marches currently in flight (`status == 'marching'`) — prevents using teleport to desync march distance calculations mid-flight.
- Explicit-coordinate teleport should still respect newbie-zone/high-level-zone boundaries (e.g. a level-3 castle can't teleport into a region gated for castle level 15+) to avoid griefing low-level players by teleporting a strong account next to them — validated the same way castle-level building gates work in Volume 2.

---

## 10. World Events

### 10.1 Scope for Volume 3
World events here means **map-level broadcast state**, not the full live-ops event system (shop tie-ins, battle-pass progress — Volume 12). This volume defines the mechanism: a world-scoped notification/broadcast channel plus a `world_event` storage collection for state like "double resource-node spawn rate this weekend" or "boss X has spawned at (512, 480)."

```typescript
interface WorldEvent {
  eventId: string;
  eventType: string; // 'boss_spawn' | 'resource_bonus' | 'pvp_window' | ...
  startTick: number;
  endTick: number;
  payload: any;
}
```

### 10.2 Broadcast mechanism
Uses Nakama's realtime socket stream, not a per-player notification — every connected client on a shard subscribes to a shared **stream** (Nakama's `Stream` concept, distinct from a match) for world events, keeping this decoupled from any specific match handler's lifecycle. A boss spawn (Section 5.3) publishes to this stream so clients see it appear on their world map view in real time without polling.

---

## 11. Summary: RPC & Match Handler Inventory for Volume 3

| Name | Type | Purpose |
|---|---|---|
| `claim_tile` | RPC | Generic tile claim (used internally by castle placement, resource node gathering start) |
| `attack_tile` | RPC | Attack a monster or player castle tile (async combat, per §5.1) |
| `start_march` | RPC | Begin any march (attack/gather/reinforce/scout) |
| `recall_march` | RPC | Abort an in-flight march (§6.4) |
| `teleport_castle` | RPC | Relocate castle tile (§9.2) |
| `get_world_view` | RPC | Fetch tiles for a viewport region (paginated by region key, §2.1) |
| `boss_match` | Match handler | Multi-party boss fight rally + resolution (§5.2) |
| *(external scheduler)* | Cron-style RPC | March-arrival sweep, resource-node respawn, boss spawn cadence |

---

## Volume 3 — Summary of Deliverables for Engineering

- [ ] `world_tile` storage collection + region-keyed viewport query (`get_world_view`)
- [ ] Version-checked `claimTile`/`vacateTile` helpers used by every tile mutation (no exceptions — §2.3)
- [ ] `army_march` collection + lazy arrival resolution wired into `get_full_state`
- [ ] External scheduler job: march-arrival sweep (defender notification even if attacker is offline)
- [ ] Resource node lifecycle: gather start, lazy depletion, cargo transfer on return
- [ ] Neutral monster attack path (reuses async combat RPC shape from Volume 1's philosophy)
- [ ] Boss match handler skeleton (full combat resolution stubbed until Volume 6)
- [ ] `initializeNewPlayer` extended to claim a starting castle tile in a newbie zone
- [ ] Scout march + `ScoutReport` collection
- [ ] Teleport RPC with in-flight-march and zone-boundary guards
- [ ] World event stream (Nakama Stream subscription) + `world_event` collection

## Explicitly deferred out of Volume 3
- Full combat resolution formulas (monsters/bosses/players all currently call a stubbed resolver — Volume 6)
- Troop carry capacity affecting gather cargo caps precisely (Volume 5)
- Hero/research speed and stealth bonuses referenced in §6.2/§7.3 (Volumes 4/2.5)
- Alliance territory claiming beyond the `ownerAllianceId` field existing (Volume 7)
- Full live-ops event content — only the broadcast mechanism is built here (Volume 12)

---

*End of Volume 3. Volume 4 (Heroes) and Volume 5 (Army) are the natural next steps — both are referenced as stubs throughout this volume (march speed, carry capacity, combat resolution) and should land before Volume 6 (Combat) can be implemented for real.*