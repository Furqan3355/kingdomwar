# Storm of Wars–Inspired MMORTS
## Technical Design Document — Volume 1: Core Architecture
### Unity + Nakama

*Original design specification. All systems, formulas, and data structures below are new designs for this project, not extracted from any existing game's source or assets.*

---

## 1. Vision and Gameplay Pillars

### 1.1 Elevator pitch
A cross-platform MMORTS where players build a city, train armies, recruit heroes, and fight for territory on a shared, persistent world map, within alliances that wage large-scale wars across kingdom shards.

### 1.2 Gameplay pillars

| Pillar | Design intent | Systems it drives |
|---|---|---|
| **Persistent growth** | Progress never fully resets during a season; upgrades, heroes, and army feel permanent | City system, Hero system |
| **Asynchronous conflict** | Meaningful PvP doesn't require both players online simultaneously | Army/March system, Combat |
| **Social gravity** | Alliance membership should be more valuable than solo play at every stage | Alliance system, Rally attacks |
| **Bounded sessions** | Core loop completable in 3–5 minute sessions, with longer strategic sessions optional | UI/UX, notification design |
| **Seasonal stakes** | Long-term goals reset on a kingdom timer to keep late-game competitive | Kingdom lifecycle, Crown Wars |

### 1.3 Core loop (30-second version)
Collect resources (idle/passive) → spend on building upgrades and troop training → scout/attack world map targets or defend against incoming attacks → earn resources/hero shards from combat outcomes → reinvest.

### 1.4 Non-goals for v1
- No real-time twitch combat (all combat is formula-resolved, not player-skill-based aiming)
- No open-world free movement — the world map is a strategic grid, not a rendered 3D space
- No cross-shard live matches at launch (Volume 8 covers this as a post-launch system)

---

## 2. Client/Server Architecture

### 2.1 Authority model
**Server is authoritative for all state that affects other players or economy balance.** This includes: resources, building levels, troop counts, combat outcomes, alliance membership, world tile ownership.

**Client is authoritative for:** camera, UI state, cosmetic animation timing, local input handling.

### 2.2 High-level topology

```
┌─────────────┐        WebSocket (realtime)        ┌──────────────┐
│ Unity Client│ ◄─────────────────────────────────► │              │
│             │        HTTP/gRPC (RPC calls)        │   Nakama     │
│  (per       │ ◄─────────────────────────────────► │   Server     │
│  player)    │                                      │   Cluster    │
└─────────────┘                                      └──────┬───────┘
                                                              │
                                                     ┌────────▼────────┐
                                                     │  PostgreSQL /    │
                                                     │  CockroachDB     │
                                                     └──────────────────┘
```

- **RPC calls** (request/response) — used for anything that isn't inherently "live": building upgrades, troop training, hero equip, shop purchases, attack resolution.
- **Realtime socket** — used for: chat, live rally match state, notification push, presence (online alliance members), world tile ownership change broadcasts.
- **Match handlers** — used only where multiple clients must observe shared, ticking state (rally windows, live boss fights).

### 2.3 Why this split
A common mistake in MMORTS architecture is routing everything through live matches "for consistency." This wastes server resources — most actions (upgrade a building, train troops) are single-player-scoped and don't need a ticking match loop. Reserve match handlers for genuinely multi-party, time-sensitive state.

### 2.4 Client-side prediction policy
Because combat and economy are server-authoritative, the client does **local optimistic UI updates only for latency hiding**, always reconciled against the next server state push:

- Tapping "upgrade building" immediately shows the timer running client-side, but the true finish time comes from the server response; if the RPC fails (e.g. insufficient resources due to a race), the client rolls back the timer and shows an error toast.
- Troop training queue shows an optimistic queued item instantly; server response confirms/corrects the ETA.

No prediction is applied to combat outcomes — those are always "wait for server response" since showing a wrong outcome, even briefly, erodes trust in an authoritative combat system.

---

## 3. Unity Project Structure

```
Assets/
├── _Project/
│   ├── Scenes/
│   │   ├── Boot.unity
│   │   ├── Login.unity
│   │   ├── City.unity
│   │   ├── WorldMap.unity
│   │   └── Battle.unity          (battle report playback, not live rendering)
│   ├── Scripts/
│   │   ├── Core/                 (bootstrapping, service locator, DI container)
│   │   ├── Networking/           (NakamaClientService, RPC wrappers, socket handlers)
│   │   ├── City/                 (building views, city grid controller)
│   │   ├── WorldMap/             (tile rendering, march visualization)
│   │   ├── Heroes/
│   │   ├── Army/
│   │   ├── Combat/               (battle report renderer — deterministic replay from server data)
│   │   ├── Alliance/
│   │   ├── UI/                   (screens, widgets, MVVM bindings)
│   │   ├── Data/                 (ScriptableObject definitions — see Section 9)
│   │   └── Utils/
│   ├── Prefabs/
│   ├── ScriptableObjects/        (building configs, unit configs, hero configs)
│   ├── Addressables/
│   └── Art/
├── Plugins/
│   └── Nakama/                   (Nakama Unity SDK)
└── ThirdParty/
```

### 3.1 Architectural pattern
**MVVM with a lightweight service locator**, not full DI framework (Zenject optional but not required for a team of this scale). Rationale: MMORTS UI is screen-heavy; MVVM keeps view logic testable without pulling in Update() polling everywhere.

```csharp
// Core/ServiceLocator.cs
public static class Services {
    public static NakamaClientService Nakama { get; private set; }
    public static PlayerDataService PlayerData { get; private set; }
    public static void Initialize() {
        Nakama = new NakamaClientService();
        PlayerData = new PlayerDataService(Nakama);
    }
}
```

### 3.2 Scene flow
`Boot` → initializes services, checks for saved session token → `Login` (if none) → `City` (default post-login scene) → player can switch to `WorldMap` via a UI overlay, not a scene reload (world map and city share a persistent "shell" scene with additive scene loading for performance).

**Recommendation:** Use **additive scene loading** for City/WorldMap rather than single-scene swaps — this avoids re-initializing the network layer and lets the alliance chat panel persist across both.

---

## 4. Nakama Backend Architecture

### 4.1 Runtime module language choice
**TypeScript for game logic, Go for hot-path/performance-critical functions.** Start everything in TypeScript for velocity; profile after alpha and port only functions that show up as bottlenecks (typically: combat resolution at scale, world tile contention resolution).

### 4.2 Module organization

```
nakama/modules/
├── main.ts                    (registers all RPCs, hooks, match handlers)
├── auth/
│   └── hooks.ts                (after-authenticate hooks)
├── economy/
│   ├── resources.ts            (production tick calculation)
│   └── buildings.ts            (upgrade validation + application)
├── army/
│   ├── training.ts
│   └── march.ts
├── combat/
│   ├── resolver.ts             (shared by async attacks and live rallies)
│   └── formulas.ts
├── alliance/
│   ├── groups.ts
│   └── territory.ts
├── worldmap/
│   └── tiles.ts
└── matches/
    └── rally_match.ts
```

### 4.3 Nakama features mapped to systems

| Nakama feature | Used for |
|---|---|
| Storage engine | Player state, world tiles, alliance data |
| Groups | Alliances |
| Leaderboards | Power rankings, war scoreboards, seasonal rankings |
| Matches | Rally battles, boss fights |
| Parties | Rally troop pooling before a match starts |
| Notifications | Attack alerts, building complete, alliance invites |
| Chat channels | Alliance chat, world chat, private messages |
| Scheduled/cron-style RPCs | Daily reset, event rotation (triggered externally — see 4.4) |

### 4.4 Scheduling note
Nakama has no built-in cron scheduler. Use an external lightweight scheduler (a small container running `cron` or a Kubernetes CronJob) that calls authenticated server-to-server RPCs on schedule (daily reset, event start/end, season rollover). This keeps scheduling infrastructure outside the game logic modules, which stay stateless.

---

## 5. PostgreSQL Schema (Volume 1 subset)

Nakama manages its own core tables (`users`, `storage`, `groups`, etc.) — do not modify these directly. This section covers **custom tables** for data that doesn't fit Nakama's key-value storage model well: primarily static configuration data and anything requiring complex relational queries or reporting.

```sql
-- Static building configuration (read-heavy, rarely written, ideal for a real table
-- rather than storage engine key-value, since designers may query/join across it)
CREATE TABLE building_config (
    building_id     TEXT PRIMARY KEY,
    display_name    TEXT NOT NULL,
    max_level       INT NOT NULL,
    category        TEXT NOT NULL, -- 'production' | 'military' | 'defense' | 'utility'
    unlock_castle_level INT NOT NULL DEFAULT 1
);

CREATE TABLE building_level_config (
    building_id     TEXT REFERENCES building_config(building_id),
    level           INT NOT NULL,
    upgrade_time_seconds INT NOT NULL,
    cost_gold       BIGINT NOT NULL,
    cost_crystal    BIGINT NOT NULL,
    cost_mithril    BIGINT NOT NULL,
    production_rate NUMERIC,       -- null for non-production buildings
    PRIMARY KEY (building_id, level)
);

-- Season/kingdom metadata — needs relational queries for admin tooling & analytics
CREATE TABLE kingdom_shard (
    shard_id        SERIAL PRIMARY KEY,
    shard_name      TEXT NOT NULL,
    opened_at       TIMESTAMPTZ NOT NULL,
    closes_at       TIMESTAMPTZ,
    status          TEXT NOT NULL DEFAULT 'active' -- 'active' | 'merging' | 'closed'
);

CREATE TABLE player_shard_membership (
    user_id         UUID NOT NULL,
    shard_id        INT REFERENCES kingdom_shard(shard_id),
    joined_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, shard_id)
);
```

**Design rule of thumb applied throughout this document:** if data is per-player and read/written as a single blob during gameplay (kingdom state, army composition), it belongs in **Nakama storage**. If data is shared configuration, needs joins/aggregation, or is queried by admin/analytics tooling, it belongs in a **custom Postgres table**. Volume 10 covers the full schema; this section only establishes the pattern.

---

## 6. Authentication and Accounts

### 6.1 Supported methods (launch)
1. Device ID (guest, silent, default for first launch)
2. Email + password (account linking, prompted after session 3 or on first purchase)
3. Google Play Games (Android)
4. Sign in with Apple (iOS)

### 6.2 Account linking flow
Guest accounts must be linkable to a permanent identity without creating a duplicate Nakama account. Use Nakama's `linkX` methods (`linkEmail`, `linkGoogle`, `linkApple`) against the **existing session's user ID**, rather than authenticating fresh and merging — merging two populated accounts post-hoc is an anti-pattern that causes data loss risk and should be avoided by prompting linking early.

### 6.3 Server hook: `afterAuthenticate`

```typescript
function afterAuthenticate(ctx: nkruntime.Context, logger: nkruntime.Logger,
    nk: nkruntime.Nakama, data: any) {
  const userId = ctx.userId;
  const existing = nk.storageRead([{ collection: 'kingdom', key: 'state', userId }]);
  if (existing.length === 0) {
    initializeNewPlayer(nk, userId);
  } else {
    resolveOfflineProgress(nk, userId);
  }
  assignToShardIfNeeded(nk, userId);
}
```

### 6.4 New player initialization
`initializeNewPlayer` writes the starting `kingdom` storage object, grants starter resources per `building_level_config` defaults, and assigns the player to the current lowest-population **open** shard (see `kingdom_shard` table, Section 5) — new players should land in active, still-growing shards rather than mature ones, per standard MMORTS shard-seeding practice.

---

## 7. Player Data Model

### 7.1 Core `kingdom` storage object (per player)

```typescript
interface KingdomState {
  userId: string;
  shardId: number;
  castleLevel: number;
  buildings: Record<string, BuildingInstance>; // keyed by building_id + slot
  resources: { gold: number; crystal: number; mithril: number };
  lastCalculatedTick: number;       // for lazy production resolve, per Vol.1 §9
  army: Record<string, number>;     // unitId -> count, garrisoned troops only
  researchLevels: Record<string, number>;
  allianceId: string | null;
  displayName: string;
  power: number;                    // derived, recalculated on major state change
}

interface BuildingInstance {
  buildingId: string;
  slot: string;          // city grid position identifier
  level: number;
  upgradeFinishTick: number | null; // null if not currently upgrading
}
```

### 7.2 Derived vs. stored fields
`power` is **derived** (sum of building/troop/hero power scores) but **cached** in storage and recalculated on any state-changing write, rather than computed on every read — it's queried far more often (leaderboards, alliance overview) than it changes, so caching is the correct tradeoff here.

### 7.3 Separate collections referencing `kingdom`
Armies that are currently marching, hero rosters, and inventory are **not** embedded in the `kingdom` object — they live in their own collections (`army_march`, `hero_roster`, `inventory`) to avoid write contention: a player queuing a march shouldn't require rewriting the entire kingdom blob, and vice versa. This follows the general storage rule: co-locate data that's read/written together (Section 5's guidance), and separate data with different write frequencies.

---

## 8. Save/Load Pipeline

### 8.1 "Save" is implicit, not explicit
There is no client-triggered "save game" — every state-changing action is an RPC that writes directly to Nakama storage as part of its execution. This eliminates an entire class of bugs (lost progress from a missed save) common in less rigorous designs.

### 8.2 Load sequence on session start
1. Client authenticates → receives session token
2. Client calls `get_full_state` RPC (single aggregated call, not N+1 separate calls per system) which server-side gathers: kingdom state, army, hero roster, inventory, alliance summary, pending notifications
3. Server resolves any offline progress (Section 6.3) **before** assembling the response, so the client never has to separately ask "has anything changed since I was away"
4. Client hydrates all local ViewModels from this single payload

```typescript
function rpcGetFullState(ctx, logger, nk, payload): string {
  const userId = ctx.userId;
  const kingdom = getKingdomState(nk, userId); // includes lazy resource resolve
  const army = getMarchingArmies(nk, userId);
  const heroes = getHeroRoster(nk, userId);
  const alliance = kingdom.allianceId ? getAllianceSummary(nk, kingdom.allianceId) : null;
  return JSON.stringify({ kingdom, army, heroes, alliance });
}
```

### 8.3 Why not autosave-on-interval
An interval-based autosave (e.g. "save every 30s") is the wrong pattern here — it introduces a window where a crash loses real progress, and doesn't fit a design where the server is authoritative anyway. Every meaningful action already round-trips to the server; there is nothing left for a periodic save to protect.

---

## 9. Configuration Data

### 9.1 Two-tier config strategy

| Tier | Format | Owner | Use case |
|---|---|---|---|
| **Design-time balancing data** | Unity ScriptableObjects | Game designers | Building costs, unit stats, hero skill values — anything designers iterate on directly in-editor |
| **Server source of truth** | PostgreSQL tables (Section 5) + exported JSON | Backend | The values Nakama actually uses to validate/execute — must match client display exactly |

### 9.2 Keeping client and server in sync
Design a **single export pipeline**: ScriptableObjects are the authored source; an Editor build step exports them to JSON, which is:
1. Bundled into the Unity client (for display purposes — showing costs before confirming an action)
2. Imported into the `building_level_config` / equivalent Postgres tables via a migration script, becoming the values Nakama's runtime modules actually enforce

**Critical rule:** the client's copy of config data is *display-only*. Every cost, timer, and formula is re-validated server-side against the authoritative table on every RPC — the client copy existing only prevents a network round-trip just to show "this upgrade costs 500 gold" in the UI.

```
[Designer edits ScriptableObject in Unity Editor]
              │
              ▼
   [Editor export tool → JSON]
              │
      ┌───────┴────────┐
      ▼                ▼
[Bundled in client]  [Migration script → Postgres]
                              │
                              ▼
                  [Nakama runtime reads at request-time]
```

This avoids the classic MMO bug class of "client shows one cost, server charges another" — because both ultimately trace to the same authored source, exported through one pipeline rather than hand-maintained twice.

---

## Volume 1 — Summary of Deliverables for Engineering

- [ ] Nakama docker-compose + module scaffold matching Section 4.2 folder layout
- [ ] Postgres migrations for `building_config`, `building_level_config`, `kingdom_shard`, `player_shard_membership`
- [ ] `afterAuthenticate` hook with new-player init + shard assignment
- [ ] `get_full_state` aggregated RPC
- [ ] Unity project skeleton matching Section 3 folder structure, with `Boot` → `Login` → `City` scene flow and `NakamaClientService` wrapper
- [ ] ScriptableObject → JSON → Postgres config export pipeline (even a minimal version, to establish the pattern before Volume 2's building system needs it)

---

*End of Volume 1. Volume 2 (City System) builds directly on the `BuildingInstance` model and config pipeline defined here.*