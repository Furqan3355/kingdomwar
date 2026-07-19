# Storm of Wars–Inspired MMORTS
## Technical Design Document — Volume 8: Kingdom Systems
### Unity + Nakama

*Builds on the `kingdom_shard` table (Volume 1 §5) and Volume 7's alliance-war scoreboard mechanism. Defines the shard's full lifecycle and larger seasonal structures. All large-scale conflict here is scored via individual fortress-attack outcomes (Volume 6 Revision 2) — no combined-army mechanics reappear at this scale either.*

---

## 1. Kingdom Lifecycle

A "kingdom" = one shard (`kingdom_shard` row, Volume 1 §5). Lifecycle states, extending the existing `status` column:

```
active (accepting new players, per Volume 1 §6.4's shard-assignment logic)
   → mature (still playable, no longer receiving new-player assignment — Volume 1's
     getLowestPopulationOpenShard query already only selects 'active' shards, so this
     transition needs no query change, just a status flip by the external scheduler)
   → merging (paired with another kingdom for a merge event, §2)
   → closed (post-season archive, read-only)
```

---

## 2. Cross-Kingdom Matchmaking (Shard Merges)

When a kingdom's population drops too low for healthy alliance wars (Volume 7 §9), the external scheduler (same mechanism as Volume 1 §4.4) flags two `mature` shards for merge:

```sql
CREATE TABLE IF NOT EXISTS kingdom_merge (
    merge_id       SERIAL PRIMARY KEY,
    shard_id_from  INT REFERENCES kingdom_shard(shard_id),
    shard_id_into  INT REFERENCES kingdom_shard(shard_id),
    scheduled_tick BIGINT NOT NULL,
    status         TEXT NOT NULL DEFAULT 'scheduled' -- 'scheduled' | 'in_progress' | 'complete'
);
```

Merge execution: every `KingdomState.shardId` in the losing shard is reassigned, and every `world_tile` (Volume 3 §2.1) from that shard needs new coordinates in the destination shard's grid — since both grids are the same fixed size (Volume 3 §1.1), this requires a **conflict-resolution pass** (players whose new coordinates would overlap an existing destination-shard player get relocated to the nearest open tile, reusing the teleport logic's `findRandomEmptyTileNear` from Volume 3 §9.2). This is a genuinely heavy, one-time batch operation — run it via an offline migration script, not a live RPC.

---

## 3. Faction Wars

### 3.1 Concept
Distinct from alliance wars (Volume 7 §9, alliance-vs-alliance) — faction wars are **kingdom-wide**, splitting the entire shard's active players into 2-4 large factions (could align with the 4 hero factions from Volume 6 Revision 2 §4, purely thematically) for a scored season-long conflict.

### 3.2 Data
```typescript
interface FactionWarState {
  shardId: number;
  factionId: string;
  score: number; // aggregated from every resolveCombat where attacker/defender are on opposing factions
}
```
Faction assignment happens once per player (RPC `join_faction`, locked once chosen or changeable only during a cooldown window) and is stored as a field on `KingdomState`. Scoring reuses the exact same "score on `resolveCombat` output" hook as alliance wars (Volume 7 §9) — just a different Leaderboard scope (`faction:{shardId}:{factionId}` instead of `war:{warId}`).

---

## 4. Citadel Wars

### 4.1 Concept
A neutral, high-value world-map structure (a special `world_tile` type, `citadel`) that any faction/alliance can attempt to capture — capture is decided by cumulative fortress-attack-style assaults against the citadel's garrison (which is populated by whichever faction currently holds it, functioning like a very strong neutral-monster-adjacent target per Volume 3 §5, but ownership-transferable).

### 4.2 Data
```typescript
interface CitadelTile extends WorldTile {
  tileType: 'citadel';
  occupantData: {
    holdingFactionId: string | null;
    garrisonTroops: Record<string, number>;
    captureProgress: number; // 0-100, decays slowly if uncontested
  };
}
```
A successful attack (via the same `attack_tile` → `resolveCombat` path as any fortress attack, Volume 6 Revision 2 §1) against a citadel adds to `captureProgress` proportional to win margin rather than transferring ownership instantly on one win — makes capture a sustained-effort objective, matching the "citadel war" framing rather than a single skirmish.

---

## 5. Crown Wars

### 5.1 Concept
The end-of-season, shard-wide culminating event: whichever faction holds the most citadels (§4) and/or has the highest faction-war score (§3) at season end is declared the "Crown" holder, driving Section 6's seasonal reset rewards.

### 5.2 Scoring aggregation
```typescript
function calculateCrownWinner(shardId: number, seasonId: string): string {
  const citadelHolds = countCitadelsHeldByFaction(shardId); // majority weight
  const warScores = getFactionWarScores(shardId, seasonId);  // tiebreaker weight
  // Exact weighting formula is a design/balance decision — this function's
  // contract is "returns one factionId," not a specific weighting constant.
  return determineWinner(citadelHolds, warScores);
}
```

---

## 6. Seasonal Resets

### 6.1 What resets, what doesn't
Per Volume 1 §1.2's "Persistent growth" pillar, **individual player progress does not reset** — hero rosters, building levels, equipment all persist. What resets each season: faction assignments (players may rejoin a faction), citadel ownership, faction-war/citadel scoreboards, and any season-scoped cosmetic rewards track.

### 6.2 Reset execution
Triggered by the external scheduler at a configured season boundary (same cron-style mechanism used throughout this TDD): archive final scoreboards to a `season_history` table, reset `FactionWarState.score` to 0, reset all citadel `occupantData` to unclaimed, leave every player's `KingdomState` untouched.

---

## 7. Rankings

Kingdom-scoped and season-scoped rankings both reuse Nakama **Leaderboards** (already the established tool for scoreboards throughout Volumes 1, 6, 7):
- Individual power ranking — leaderboard scoped per shard, score = `KingdomState.power`.
- Alliance ranking — leaderboard scoped per shard, score = sum of member power or alliance-war score.
- Faction ranking — leaderboard scoped per shard, score = `FactionWarState.score`.

---

## 8. Rewards

Season-end rewards (hero shards, equipment, cosmetics) are distributed via a batch job reading final leaderboard standings and writing to each qualifying player's `inventory` collection (Volume 4 §4.1) — no new delivery mechanism, reuses the existing inventory-item write path.

---

## Volume 8 — Summary of Deliverables

- [ ] `kingdom_merge` table + offline merge-migration script (conflict-resolution pass for overlapping tile coordinates)
- [ ] `join_faction` RPC + `FactionWarState`/faction-scoped Leaderboard
- [ ] `citadel` tile type + capture-progress logic layered onto the existing `attack_tile`/`resolveCombat` path
- [ ] `calculateCrownWinner` + season-end batch job (scoreboard archive, resets, reward distribution)
- [ ] Unity: faction selection screen, citadel map overlay, season rankings screen, crown war results screen

## Explicitly deferred
- Exact crown-winner weighting formula (design/balance decision, not an engineering gap)
- Cross-shard (not just cross-kingdom-merge) faction wars — out of scope, this volume assumes faction wars are single-shard

---
*End of Volume 8. This closes the "meta-game" arc (Volumes 7-8) sitting on top of the core simulation (Volumes 1-6). Volume 9 (Nakama Backend) now consolidates the backend patterns used across all eight volumes into one reference document.*
