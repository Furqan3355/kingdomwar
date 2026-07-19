# Storm of Wars–Inspired MMORTS
## Technical Design Document — Volume 2: City System
### Unity + Nakama

*Builds directly on Volume 1's `BuildingInstance` model, generic `upgrade_building` RPC, and the ScriptableObject → JSON → Postgres config pipeline. This volume does not introduce a new upgrade mechanism — it fills the generic framework with real buildings and adds the building-specific behavior that framework didn't cover.*

---

## 1. City Scene Architecture

### 1.1 Scene composition
The `City` scene (referenced by `BootController` in Volume 1) is a fixed isometric or top-down grid, not a freely scrollable world. Composition:

```
City (scene)
├── CityGridController          (owns grid layout, slot lookup)
├── BuildingSlotView[]           (one per grid position, instantiates a BuildingView on occupancy)
├── CityCameraRig                (pan/zoom bounded to grid extents)
├── CityHUD                      (resource bars, castle level, notifications)
└── BuildingDetailPanel          (opens on tap, shows upgrade cost/timer/prereqs)
```

### 1.2 Grid model
The city is a fixed-size grid (recommend **7×7** for launch — enough slots for the building roster below plus headroom, without becoming a placement puzzle). Each slot has a stable `slot` identifier (`"row_col"`, e.g. `"3_2"`) matching the `slot` field already defined on `BuildingInstance` in Volume 1 §7.1.

```csharp
// Assets/_Project/Scripts/City/CityGridController.cs
public class CityGridController : MonoBehaviour
{
    public const int GridSize = 7;

    public string SlotIdFor(int row, int col) => $"{row}_{col}";

    public bool IsValidSlot(string slotId)
    {
        var parts = slotId.Split('_');
        if (parts.Length != 2) return false;
        return int.TryParse(parts[0], out var r) && int.TryParse(parts[1], out var c)
               && r >= 0 && r < GridSize && c >= 0 && c < GridSize;
    }
}
```

**Server-side note:** slot validity is re-checked server-side too — `upgrade_building` currently accepts any string `slot` (Volume 1 didn't validate it because no building roster existed yet). This volume adds that check (Section 12).

### 1.3 BuildingView lifecycle
`BuildingSlotView` renders one of three states per slot: **empty** (tap to open build menu), **built** (shows building sprite/model at current level, tap opens `BuildingDetailPanel`), or **upgrading** (shows in-progress visual + countdown, driven client-side by `upgradeFinishTick` from the last server response — not a locally-owned timer that could drift from truth).

```csharp
public void Render(BuildingInstance instance)
{
    if (instance == null) { ShowEmpty(); return; }
    if (instance.upgradeFinishTick.HasValue) { ShowUpgrading(instance.upgradeFinishTick.Value); return; }
    ShowBuilt(instance.buildingId, instance.level);
}
```

### 1.4 Why not a freeform placement system
Freeform building placement (drag-and-drop anywhere) adds significant client/server validation surface (overlap checks, pathfinding around obstacles) for a genre where players expect a fixed, comparable layout across kingdoms (raid planning, defense comparison). Volume 2 uses **fixed slots per building type** instead — simpler to validate, and matches the reference genre's conventions.

---

## 2. Building Framework

### 2.1 What Volume 1 already gave us
From Volume 1: `BuildingInstance` (buildingId, slot, level, upgradeFinishTick), `building_config`/`building_level_config` tables, and a generic `upgrade_building` RPC that validates cost/level-cap/castle-level-gate and applies a timer.

### 2.2 What this volume adds to the framework
1. **Slot-type binding** — each building type is restricted to specific slot(s), not "any empty slot." (Section 12)
2. **Building prerequisites** beyond castle level — some buildings require another building to be at a minimum level first (Section 13).
3. **Per-building special behavior** — e.g. Storage buildings raise a resource *cap* rather than a *rate*; Hospital has a capacity rather than a production stat. The generic framework only handles `production_rate`; this volume extends the schema (Section 2.3) to cover these.
4. **The full building roster**, seeded into `building_config`/`building_level_config`.

### 2.3 Schema extension: `building_config`

Volume 1's `building_config` table gets two new nullable columns to support non-production building types without overloading `production_rate`'s meaning:

```sql
ALTER TABLE building_config
    ADD COLUMN IF NOT EXISTS resource_type TEXT,      -- 'gold' | 'crystal' | 'mithril' | NULL
    ADD COLUMN IF NOT EXISTS effect_type TEXT NOT NULL DEFAULT 'production';
    -- effect_type: 'production' | 'storage_cap' | 'troop_capacity' | 'defense_stat' | 'utility'
```

This directly resolves the gap flagged in Volume 1's `resources.ts` comment ("Volume 2 formalizes this with a `resource_type` column instead of a naming convention"). Volume 1's building-ID-prefix inference (`gold_factory` → gold) is now replaced by reading `resource_type` directly:

```typescript
// modules/economy/resources.ts — REPLACES the naming-convention branch
const cfg = getBuildingConfig(nk, b.buildingId);
const levelCfg = getBuildingLevelConfig(nk, b.buildingId, b.level);
if (cfg.effect_type === 'production' && levelCfg.production_rate !== null) {
  if (cfg.resource_type === 'gold') goldRate += levelCfg.production_rate;
  else if (cfg.resource_type === 'crystal') crystalRate += levelCfg.production_rate;
  else if (cfg.resource_type === 'mithril') mithrilRate += levelCfg.production_rate;
}
```

### 2.4 Schema extension: `building_level_config`
Storage cap, troop capacity, and defense stat values don't fit `production_rate` cleanly either (a Storage building's "rate" is meaningless — it has a flat cap per level). Add a generic secondary stat column:

```sql
ALTER TABLE building_level_config
    ADD COLUMN IF NOT EXISTS stat_value NUMERIC;
    -- interpretation depends on building_config.effect_type:
    --   storage_cap     -> max resource this building type can hold
    --   troop_capacity  -> Hospital: wounded-troop slots; Barracks: training queue size
    --   defense_stat    -> Wall: HP bonus %; Watch Tower: incoming-scout detection radius
```

This keeps one row-per-level shape for every building rather than a different table per building type — simpler for the config export pipeline (Volume 1 §9) to remain building-type-agnostic.

---

## 3–11. The Building Roster

Each building below is defined as: **role**, **effect_type/resource_type**, **slot binding**, **level range for launch (1–10 unless noted)**, and any building-specific server logic beyond the generic upgrade framework.

> Cost/timer curves are intentionally left as placeholder formulas in Section 14 rather than final numbers — economy balancing is a live-tuned process, not a one-time spec decision. Design gives final per-level numbers via the ScriptableObject pipeline; this document defines the *shape* of the curve.

### 3. Gold Factory
- `effect_type = 'production'`, `resource_type = 'gold'`
- Slot binding: 2 fixed slots (`gold_factory` at slots `"1_1"`, `"1_2"`) — multiple instances of the same production building are standard for the genre (lets players scale gold output without a single mega-building).
- No building-specific server logic beyond the generic framework.

### 4. Gold Storage
- `effect_type = 'storage_cap'`, `resource_type = 'gold'`
- Slot binding: 1 fixed slot (`"1_3"`)
- **Server logic addition:** resource resolve (Volume 1 `resources.ts`) must clamp `resources.gold` to the current storage cap after applying production, not just add unbounded:
```typescript
const goldCap = getStorageCap(nk, state, 'gold');
state.resources.gold = Math.min(state.resources.gold + elapsed * goldRate, goldCap);
```
- `getStorageCap` sums `stat_value` across all built instances of buildings with `effect_type = 'storage_cap' AND resource_type = 'gold'` (only Gold Storage in v1, but written generically in case a hero/research bonus adds a second source later).

### 5. Crystal Factory
- `effect_type = 'production'`, `resource_type = 'crystal'`
- Slot binding: 1 fixed slot (`"2_1"`)
- Unlocks at `unlock_castle_level = 3` — crystal is the mid-tier resource, gated later than gold per standard MMORTS resource-tiering.

### 6. Crystal Storage
- `effect_type = 'storage_cap'`, `resource_type = 'crystal'`
- Slot binding: 1 fixed slot (`"2_2"`)
- Same clamp logic as Gold Storage (Section 4), parameterized by resource type.

### 7. Mithril Factory
- `effect_type = 'production'`, `resource_type = 'mithril'`
- Slot binding: 1 fixed slot (`"3_1"`)
- Unlocks at `unlock_castle_level = 8` — mithril is the premium late-game resource (used for hero ascension in Volume 4, top-tier troop upkeep in Volume 5).

### 8. Mithril Storage
- `effect_type = 'storage_cap'`, `resource_type = 'mithril'`
- Slot binding: 1 fixed slot (`"3_2"`)

### 9. Castle
- `effect_type = 'utility'`, `resource_type = null`
- Slot binding: 1 fixed slot (`"4_4"`, center of the grid)
- **Special: Castle level is not just "this building's level"** — `KingdomState.castleLevel` (Volume 1 §7.1) is a top-level field because it gates every other building's `unlock_castle_level`. The Castle building's own `BuildingInstance.level` and `KingdomState.castleLevel` must always move together — the upgrade RPC has a Castle-specific branch (Section 15) that updates both atomically rather than treating Castle as a generic building.
- Max level for launch: **15** (higher than the 10-level default — Castle is the long-term progression spine).

### 10. Academy
- `effect_type = 'utility'`, `resource_type = null`
- Slot binding: 1 fixed slot (`"5_1"`)
- Role: unlocks and hosts the research tree (`KingdomState.researchLevels`, defined but unpopulated in Volume 1). Research itself (tree structure, effects) is **out of scope for Volume 2** — Academy's building-level entry here only covers it as a *building* (cost/timer/prereqs to construct and upgrade); the research system it unlocks is a Volume 2.5/3-adjacent system to be scoped separately, since research effects touch combat/army formulas from later volumes.

### 11. Barracks, Hospital, Wall, Watch Tower, Embassy

| Building | effect_type | Slot | Role | Volume 2 scope | Deferred to |
|---|---|---|---|---|---|
| **Barracks** | `troop_capacity` (`stat_value` = training queue slots) | `"5_2"` | Troop training entry point | Building shell only — queue mechanics need `army` collection design | Volume 5 |
| **Hospital** | `troop_capacity` (`stat_value` = wounded-troop capacity) | `"5_3"` | Holds wounded troops instead of permanent losses on defense | Building shell only — casualty rules need combat resolver | Volume 5/6 |
| **Wall** | `defense_stat` (`stat_value` = HP/defense bonus %) | `"6_1"`, non-relocatable, always present at level 0 | Base defense multiplier | Building shell + stat_value read into defense calc stub | Volume 6 |
| **Watch Tower** | `defense_stat` (`stat_value` = scout detection radius) | `"6_2"` | Reveals incoming attacks before they land | Building shell only — needs march/scouting system | Volume 3/5 |
| **Embassy** | `utility` | `"6_3"` | Alliance-related actions (help requests, gifting) hosted here | Building shell only — needs Alliance system | Volume 7 |

**Design rule applied consistently above:** Volume 2 builds every building's *presence in the city* (buy, upgrade, prerequisites, visual states) so the City scene is fully playable end to end, but does **not** implement gameplay systems that depend on volumes not yet written (combat, army, alliance). This avoids half-implementing systems out of order, per the original rules document's "what not to build yet" guidance.

---

## 12. Building Prerequisites

Two kinds of prerequisite, both validated server-side inside `upgrade_building` before the existing cost/level checks run:

### 12.1 Castle-level gate (already in Volume 1)
`state.castleLevel < buildingCfg.unlock_castle_level` → reject. No change needed.

### 12.2 Cross-building prerequisite (new in Volume 2)
Some buildings require another building at a minimum level (e.g. Academy requires Barracks level 3). New table:

```sql
CREATE TABLE IF NOT EXISTS building_prerequisite (
    building_id            TEXT REFERENCES building_config(building_id),
    requires_building_id   TEXT REFERENCES building_config(building_id),
    requires_level         INT NOT NULL,
    PRIMARY KEY (building_id, requires_building_id)
);
```

```typescript
// modules/economy/buildings.ts — new check inserted before the cost check
const prereqs = getBuildingPrerequisites(nk, req.buildingId);
for (const prereq of prereqs) {
  const met = playerHasBuildingAtLevel(state, prereq.requiresBuildingId, prereq.requiresLevel);
  if (!met) {
    return respond({ ok: false, error: `prerequisite_not_met:${prereq.requiresBuildingId}:${prereq.requiresLevel}` });
  }
}
```

### 12.3 Slot-type binding (new in Volume 2)
Volume 1's `upgrade_building` accepted any `buildingId` at any `slot`. Volume 2 adds a lookup table so a client can't request `gold_factory` at a slot reserved for `castle`:

```sql
CREATE TABLE IF NOT EXISTS building_slot (
    slot_id      TEXT PRIMARY KEY,
    building_id  TEXT REFERENCES building_config(building_id)
);
```

```typescript
const slotBinding = getSlotBinding(nk, req.slot);
if (!slotBinding || slotBinding.buildingId !== req.buildingId) {
  return respond({ ok: false, error: 'invalid_slot_for_building' });
}
```

---

## 13. Upgrade Timers

### 13.1 Timer curve shape
Per-building `upgrade_time_seconds` (Volume 1 `building_level_config`) follows an exponential curve, standard for the genre and tuned to keep early levels fast (retention) and late levels slow (long-term engagement/monetization via speedups):

```
upgrade_time(level) = base_time * growth_factor ^ (level - 1)
```

Recommended starting values for balancing (design-owned, not server-enforced): `base_time = 30s` for tier-1 production buildings, `growth_factor ≈ 1.6–1.9` depending on building category. Castle (the progression spine) should use a flatter early curve and steeper late curve than production buildings, since Castle level gates everything else.

### 13.2 Speedup items (hook, not full implementation)
Volume 2 reserves the mechanism but doesn't implement the item system (Volume 12/Live Ops owns the shop/inventory for consumable speedups). The hook: `upgrade_building`'s response includes `upgradeFinishTick`; a future `apply_speedup` RPC only needs to read the current `BuildingInstance`, subtract seconds from `upgradeFinishTick`, and re-write — no change to this volume's upgrade logic is required to support it later.

### 13.3 Instant-complete for level 1 of core buildings
Per the Volume 1 seed data pattern (`gold_factory` level 1 costs 0 and takes 30s), consider `upgrade_time_seconds = 0` for level-1 of a small number of "starter" buildings so a brand new player's first city action feels instant. This is a design lever available in the config pipeline, not a special server code path — the generic RPC already handles a zero-second timer correctly (finish tick = now).

---

## 14. Resource Production Formulas

### 14.1 Base formula (unchanged from Volume 1)
```
resources[type] += elapsed_seconds * sum(production_rate for each built instance of that resource_type)
```
capped by storage (Section 4).

### 14.2 Per-level production curve
Recommended shape — linear-plus-level-bonus rather than pure exponential, since unbounded exponential production trivializes storage-cap balancing:

```
production_rate(level) = base_rate * (1 + growth_per_level * (level - 1))
```

Example (Gold Factory, `base_rate = 5`, `growth_per_level = 1.4`): level 1 = 5/s, level 5 = 33/s, level 10 = 68/s. Actual tuned values belong in the config pipeline, not hardcoded — this formula is the *shape* contract between design and engineering.

### 14.3 Multi-instance stacking
Where a building type has multiple slots (Gold Factory ×2, Section 3), total production for that resource is the **sum across all instances**, each independently leveled — this is already how Volume 1's/Volume 2's resolve loop works (`for key in state.buildings`), so no special-casing is needed; it falls out of the existing per-instance loop.

### 14.4 Formula ownership boundary
This section defines the *formula shape* Nakama's runtime enforces (Section 2.3's updated `resources.ts` logic). The *specific constants* (base_rate, growth_per_level per building) are authored data flowing through the Volume 1 §9 config pipeline — engineering should never hardcode a specific constant from this section into `resources.ts`; only the formula structure lives in code.

---

## 15. Castle-Specific Upgrade Logic

Because `castleLevel` is a top-level `KingdomState` field (Section 9), the generic `upgrade_building` RPC needs one building-specific branch:

```typescript
// modules/economy/buildings.ts — inserted after the generic upgrade succeeds
if (req.buildingId === 'castle') {
  state.castleLevel = newInstance.level; // kept in sync at request time...
}
// ...and again on completion, since level only actually increments when
// completeFinishedUpgrades() runs (Volume 1). Add the same sync there:
```

```typescript
// modules/economy/buildings.ts — completeFinishedUpgrades()
export function completeFinishedUpgrades(state: KingdomState): KingdomState {
  const nowSeconds = Math.floor(Date.now() / 1000);
  for (const key in state.buildings) {
    const b = state.buildings[key];
    if (b.upgradeFinishTick !== null && b.upgradeFinishTick <= nowSeconds) {
      b.level += 1;
      b.upgradeFinishTick = null;
      if (b.buildingId === 'castle') {
        state.castleLevel = b.level; // NEW in Volume 2
      }
    }
  }
  return state;
}
```

This is the only building-ID-specific branch in the generic upgrade path for Volume 2 — every other building-specific behavior (storage cap clamping, prerequisite checks) is generic across all buildings sharing an `effect_type`, not hardcoded per building ID.

---

## Volume 2 — Summary of Deliverables for Engineering

- [ ] Migration: `resource_type`/`effect_type` columns on `building_config`, `stat_value` on `building_level_config`, plus new `building_prerequisite` and `building_slot` tables
- [ ] Seed data: full 12-building roster (Sections 3–11) into `building_config`/`building_level_config`/`building_slot`
- [ ] `resources.ts`: replace naming-convention resource inference with `resource_type` column read; add storage-cap clamping
- [ ] `buildings.ts`: add prerequisite check, slot-binding validation, and the Castle-level sync branch
- [ ] Unity: `CityGridController`, `BuildingSlotView` (empty/built/upgrading states), `BuildingDetailPanel`
- [ ] Config export tool (Volume 1 `export_config.js`) extended to handle the new `resource_type`/`effect_type`/`stat_value`/prerequisite/slot-binding fields in its JSON schema

## Explicitly deferred out of Volume 2
- Research tree effects (Academy's building shell only)
- Troop training queue mechanics (Barracks shell only)
- Wounded-troop/casualty handling (Hospital shell only)
- Defense stat application in actual combat (Wall/Watch Tower shells only)
- Alliance-hosted actions (Embassy shell only)
- Speedup item consumption (mechanism hook only, per §13.2)

---

*End of Volume 2. Volume 3 (World Map) is the next dependency-free volume — Volume 5 (Army) should follow directly after, since Barracks/Hospital's shells here are waiting on it.*