# Storm of Wars–Inspired MMORTS
## Technical Design Document — Volume 5: Army System
### Unity + Nakama

*Builds on Volume 2 (Barracks/Hospital building shells), Volume 3 (march mechanics, carry capacity stub), and Volume 4 (hero assignment stub, `HeroCombatContribution`). This volume is the last major data-producing volume before Volume 6 (Combat) — it defines everything Volume 6's resolver will consume about troops, and closes out the Barracks/Hospital/march-speed/carry-capacity gaps left open by earlier volumes.*

---

## 1. Unit Types

### 1.1 Unit archetypes
Standard MMORTS rock-paper-scissors triangle, extended with a siege/support category:

| Archetype | Strong vs. | Weak vs. | Role |
|---|---|---|---|
| Infantry | Cavalry | Archers | Tanky frontline, cheap, fast to train |
| Archers | Infantry | Cavalry | Ranged damage, fragile |
| Cavalry | Archers | Infantry | Fast march speed, high attack, fragile in prolonged fights |
| Siege | Buildings/Walls | All troop types | Slow, only bonus-effective against Wall's defense_stat (Volume 2 §2.4) |

### 1.2 `unit_config` schema
```sql
CREATE TABLE IF NOT EXISTS unit_config (
    unit_id              TEXT PRIMARY KEY,
    display_name          TEXT NOT NULL,
    archetype              TEXT NOT NULL,   -- 'infantry' | 'archer' | 'cavalry' | 'siege'
    tier                    INT NOT NULL,    -- unlocks progressively via Barracks level, §2.3
    base_attack            NUMERIC NOT NULL,
    base_defense            NUMERIC NOT NULL,
    base_health              NUMERIC NOT NULL,
    base_march_speed         NUMERIC NOT NULL, -- tiles/sec, feeds Volume 3 §6.2
    base_carry_capacity      NUMERIC NOT NULL, -- resource units per troop, feeds Volume 3 §4.3/§8.1
    train_time_seconds        INT NOT NULL,
    train_cost_gold            BIGINT NOT NULL,
    train_cost_crystal          BIGINT NOT NULL,
    train_cost_mithril          BIGINT NOT NULL,
    upkeep_gold_per_hour        NUMERIC NOT NULL DEFAULT 0 -- see §1.4
);
```

### 1.3 Archetype counter formula
Rather than hardcoding "infantry beats cavalry" as an if/else chain in the combat resolver (Volume 6's territory, but the *data* this volume must expose), each archetype pairing gets an explicit multiplier row:

```sql
CREATE TABLE IF NOT EXISTS archetype_counter_config (
    attacker_archetype  TEXT NOT NULL,
    defender_archetype   TEXT NOT NULL,
    damage_multiplier     NUMERIC NOT NULL, -- e.g. 1.25 for a counter, 0.85 for countered, 1.0 neutral
    PRIMARY KEY (attacker_archetype, defender_archetype)
);
```
This keeps the counter triangle fully data-driven — design can rebalance or add a fifth archetype without a code change, consistent with this TDD's recurring "formula shape in code, constants in config" rule (established Volume 2 §14.4, reapplied here).

### 1.4 Upkeep (economy sink)
Standing army costs a small continuous gold upkeep (`upkeep_gold_per_hour` per troop), deducted via the same lazy-resolve pattern as resource production (Volume 1 §5) — computed as a negative rate contribution during `resolveProductionInMemory`, not a separate scheduled deduction. This gives large armies a real economic cost, discouraging unlimited hoarding of troops with no downside.

---

## 2. Training

### 2.1 Training queue model
Barracks (Volume 2 §11 shell) gets its real implementation here. Training is a **queue**, not a single in-flight upgrade like buildings — `Barracks.stat_value` (Volume 2 §2.4) defines queue *slot count* (how many distinct training orders can be in flight simultaneously, typically 1 at low Barracks level, up to 3-4 at max).

```typescript
// modules/army/training.ts
export interface TrainingOrder {
  orderId: string;
  unitId: string;
  quantity: number;
  startTick: number;
  finishTick: number;
  status: 'training' | 'complete';
}
```
Stored in its own collection (`training_queue`, per-player, keyed by `orderId`) — same write-frequency-separation rule as every other per-player sub-system in this TDD (Volume 1 §7.3, reapplied consistently through Volumes 3-5).

### 2.2 Training RPC
```typescript
export function rpcTrainTroops(ctx, logger, nk, payload) {
  const req = JSON.parse(payload); // { unitId, quantity }
  const userId = ctx.userId;
  const kingdom = readAndResolveKingdomState(nk, userId); // Volume 1 helper, reused directly

  const activeOrders = getActiveTrainingOrders(nk, userId);
  const barracksSlots = getBarracksSlotCount(nk, kingdom); // reads Barracks stat_value, Volume 2 §2.4
  if (activeOrders.length >= barracksSlots) {
    return respond({ ok: false, error: 'queue_full' });
  }

  const unitCfg = getUnitConfig(nk, req.unitId);
  if (!unitCfg) return respond({ ok: false, error: 'unknown_unit' });
  if (kingdom.castleLevel < getUnitUnlockCastleLevel(nk, req.unitId)) {
    return respond({ ok: false, error: 'castle_level_too_low' });
  }

  const totalCost = {
    gold: unitCfg.train_cost_gold * req.quantity,
    crystal: unitCfg.train_cost_crystal * req.quantity,
    mithril: unitCfg.train_cost_mithril * req.quantity,
  };
  if (kingdom.resources.gold < totalCost.gold /* ...and crystal/mithril */) {
    return respond({ ok: false, error: 'insufficient_resources' });
  }

  deductResources(kingdom, totalCost);
  writeKingdomState(nk, userId, kingdom);

  const order: TrainingOrder = {
    orderId: nk.uuidv4(),
    unitId: req.unitId,
    quantity: req.quantity,
    startTick: nowSeconds(),
    finishTick: nowSeconds() + unitCfg.train_time_seconds * req.quantity, // linear scaling with quantity
    status: 'training',
  };
  writeTrainingOrder(nk, userId, order);

  return respond({ ok: true, order });
}
```

### 2.3 Unit tier unlocks
Like buildings (Volume 2 §12.1), units gate on Castle level via `unit_config`-adjacent unlock data (a small `unit_unlock_config(unit_id, unlock_castle_level)` table, following the exact pattern of `building_config.unlock_castle_level` — intentionally not duplicated in full here since it's a one-to-one schema echo).

### 2.4 Completion resolution
Same lazy-resolve philosophy as buildings and marches: `completeFinishedTrainingOrders(userId)` runs inside `get_full_state` (extending Volume 1's aggregation point again) and any army-touching RPC — on completion, `quantity` is added to `KingdomState.army[unitId]` (garrisoned troop count) and the order is removed from `training_queue`.

---

## 3. Hospital

### 3.1 Role (completing the Volume 2 §11 shell)
Hospital holds **wounded** troops from a *defensive* loss (being attacked) rather than letting them die outright — a core retention mechanic in this genre (losing your whole army to one bad attack while offline is a top churn cause). Troops lost while *attacking* do not go to Hospital — only defenders' losses are salvageable, per genre convention, since it would otherwise trivialize offense risk.

### 3.2 Data
```typescript
export interface HospitalState {
  woundedTroops: Record<string, number>; // unitId -> count
  capacity: number; // from Hospital's stat_value (Volume 2 §2.4)
}
```
Held as a field on `KingdomState` rather than a separate collection — unlike training orders or marches, wounded-troop counts change at the same moments (combat resolution, healing) as garrisoned army counts and don't warrant a separate collection under the write-frequency-separation rule; they're part of the same logical "current army snapshot."

### 3.3 Healing
Wounded troops heal back to garrison over time at a rate derived from Hospital level (a `heal_rate_per_hour` value in `building_level_config.stat_value`... but Hospital already uses `stat_value` for capacity per Volume 2. **Resolution:** extend Hospital's schema with a second stat column rather than overloading one field:

```sql
ALTER TABLE building_level_config
    ADD COLUMN IF NOT EXISTS secondary_stat_value NUMERIC;
    -- Hospital: heal_rate_per_hour. Unused (null) for all other buildings.
```
This is a deliberate, explicit exception to Volume 2's single-`stat_value` pattern, called out rather than silently overloaded — Hospital is the one building needing two independent per-level stats (capacity *and* rate).

### 3.4 Overflow rule
If wounded troops exceed `capacity` (e.g. a huge defensive loss against a small Hospital), the overflow amount is lost permanently rather than rejected — matches player expectation that Hospital is a *buffer*, not a guarantee, and avoids a confusing "your combat loss RPC failed" edge case.

---

## 4. Reinforcements

### 4.1 Concept
Alliance members (Volume 7, hooked here) can send troops to garrison at another player's castle tile, strengthening that player's defense without those troops being under the defender's direct control — critical for alliance-coordinated defense against rally attacks (Section 5).

### 4.2 Data shape
Reinforcing troops are **not merged into the target's `KingdomState.army`** — they remain attributed to the sending player (for return purposes and so the sender's own army count stays accurate) but count toward the target's defense during combat resolution:

```typescript
export interface ReinforcementGarrison {
  reinforcementId: string;
  sendingUserId: string;
  targetUserId: string;
  troops: Record<string, number>;
  arrivedTick: number;
}
```
Stored in a collection keyed by `targetUserId` (queryable "who's reinforcing me") with `sendingUserId` also indexed (queryable "where are my troops stationed").

### 4.3 Recall
Sending player can recall reinforcements at any time (RPC `recall_reinforcement`), which starts a return march (Volume 3 §6 mechanics reused directly — reinforcement travel *is* a march with `marchType: 'reinforce'`, already enumerated in Volume 3 §6.1's `MarchState.marchType` union).

---

## 5. Rally Attacks

### 5.1 Recap from Volume 1 §7B
Volume 1 already established the live-match pattern for rallies (party-based troop pooling, match handler resolves at rally-window end). This volume fills in the **troop-composition mechanics** that match handler operates on.

### 5.2 Rally composition rules
- A rally has one **rally leader** (whoever initiated it) and any number of **participants** who commit troops before the rally window closes.
- Total rally army size may be capped by the target tile type — e.g. attacking a player castle allows a larger combined force than attacking a lower-tier neutral monster (prevents 50-player pile-ons on trivial content, which would be a bad experience for whoever's on the other end even PvE).
- Each participant's contributed troops remain individually attributed (for casualty reporting — see §9) even though they fight as one combined force during resolution.

```typescript
// modules/army/rally.ts — extends Volume 1's rallyMatchHandler skeleton
interface RallyParticipant {
  userId: string;
  troops: Record<string, number>;
  heroInstanceIds: string[]; // Volume 4 §8.4 contributions aggregate in at resolution time
}
```

### 5.3 Rally window and minimum participation
Rally window duration (Volume 1 §7B used a 60s example) should scale with target significance — short (30-60s) for a spontaneous small rally, longer (up to 10 min) for a scheduled alliance-wide boss/citadel assault (Volume 8 territory, hook only here). A rally with zero participants beyond the leader by window close either auto-resolves as a solo attack or auto-cancels with a full refund of committed resources — auto-cancel is the safer default to avoid a leader's army marching alone into something they only intended to attack with backup.

---

## 6. Formations

### 6.1 Scope
"Formations" in this genre typically means a lightweight **troop-order or role-slotting system**, not spatial battlefield positioning (which would require the twitch-combat model Volume 1 §1.4 explicitly ruled out). Formation here = assigning which unit archetypes/heroes occupy "front line" vs. "back line" roles, affecting which troops absorb damage first during formula-resolved combat.

### 6.2 Data
```typescript
export interface Formation {
  frontLine: string[];  // unit IDs prioritized to receive damage first
  backLine: string[];   // unit IDs (typically archers/siege) protected until front line is depleted
  heroSlots: string[];  // ordered list of heroInstanceIds, position affects hero activation priority (Volume 4 §7.2)
}
```
Stored per-player as part of `KingdomState` (a lightweight default-applies-to-all-marches setting) with an optional per-march override passed at `start_march` time (Volume 3 §6.1's `MarchState` gains an optional `formationOverride` field) for players who want different formations for different objectives.

### 6.3 Combat resolver contract
Like Volume 4 §8.4, this section's output is a contract for Volume 6, not an implementation of damage resolution itself: the resolver receives an ordered casualty-priority list per side (front line absorbs losses before back line) rather than treating an army as an undifferentiated bag of troops.

---

## 7. March Speed

### 7.1 Completing Volume 3 §6.2's stub
Volume 3 defined march duration as `distance / march_speed` and deferred "derived from the slowest unit type... plus hero/research bonuses." This volume delivers the aggregation:

```typescript
export function calculateMarchSpeed(
  nk: nkruntime.Nakama,
  troops: Record<string, number>,
  heroContributions: HeroCombatContribution[] // Volume 4 §8.4 — but speed isn't in that struct;
                                                 // see note below
): number {
  let slowest = Infinity;
  for (const unitId in troops) {
    if (troops[unitId] <= 0) continue;
    const cfg = getUnitConfig(nk, unitId);
    slowest = Math.min(slowest, cfg.base_march_speed);
  }
  // Hero march-speed bonus (hero_config.base_march_speed_bonus, Volume 4 §1.2)
  // is applied as a percentage multiplier on top of the slowest-unit base,
  // not blended per-unit — a fast hero can't offset a slow siege unit's pace.
  const heroBonus = getMarchSpeedBonusFromAssignedHeroes(nk, troops);
  return slowest * (1 + heroBonus);
}
```

**Note on the Volume 4 contract gap:** `HeroCombatContribution` (Volume 4 §8.4) only carries attack/defense/health/activation rules — march speed bonus isn't part of that struct because it's not a combat-resolution input, it's a pre-combat march-duration input. This volume adds a **second, narrower** hero query (`getMarchSpeedBonusFromAssignedHeroes`) rather than bloating Volume 4's combat contract with fields Volume 6 doesn't need — a deliberate interface-boundary decision, not an oversight.

---

## 8. Capacity

### 8.1 Completing Volume 3 §4.3/§8.1's stub
Total march carry capacity (for resource gathering, Volume 3 §4) is the sum of `base_carry_capacity` (§1.2) across all troops in the march:

```
total_capacity = sum(unit_config.base_carry_capacity * troop_count for each unit type in march)
```
Gathering (Volume 3 §4.3) stops accumulating cargo once `total_capacity` is reached even if the resource node still has remaining capacity — the army must return and re-march to continue gathering, which is the intended pacing lever (bigger/more specialized gathering armies reduce trips, a meaningful but not mandatory investment).

### 8.2 Reinforcement and rally capacity
The same `base_carry_capacity` values are irrelevant to reinforcement/rally troop counts (those aren't about cargo) — capacity in Section 8 refers specifically to gather marches; Section 5.2's rally size caps are a separate, tile-type-driven limit, not derived from carry capacity math.

---

## 9. Casualty Rules

### 9.1 Outcome categories per troop, per battle
Every unit involved in a resolved battle (Volume 6's job to compute *how many*, this volume's job to define *what happens to them*) resolves to one of:

| Outcome | Applies to | Effect |
|---|---|---|
| Survived | Winning side, proportional to margin of victory | Returns to garrison/continues march unaffected |
| Wounded | **Defending** side only, per §3.1 | Moves to Hospital (capped by capacity, §3.4) |
| Killed | Attacking side always; defending side beyond Hospital capacity | Permanently removed from `KingdomState.army` |

### 9.2 Why attackers never get the Hospital buffer
This is a deliberate, explicit asymmetry (not an oversight) consistent with §3.1's reasoning: offense that always risked zero permanent loss would make attacking nearly free, collapsing the risk/reward tension this TDD's Volume 1 §1.2 pillar table calls out ("asynchronous conflict" pillar depends on attacks having real stakes for the attacker too).

### 9.3 Reinforcement casualties
Per §4.2, reinforcing troops remain attributed to the sending player. Casualties among reinforcement troops apply the **defender's** outcome rules (§9.1's "defending side" — since they're physically defending the target's castle) but return survivors/wounded to the **sending** player's Hospital/garrison, not the target's, once resolution completes and (for wounded) once they're eventually recalled or healed.

### 9.4 Casualty report shape (Volume 6 contract)
```typescript
export interface CasualtyReport {
  userId: string;
  survived: Record<string, number>;
  wounded: Record<string, number>;
  killed: Record<string, number>;
}
```
Volume 6's combat resolver returns one `CasualtyReport` per participant (rally or 1v1); this volume's `applyCasualtyReport()` function is the only code path allowed to mutate `KingdomState.army`/`HospitalState.woundedTroops` as a result of combat, keeping that mutation logic in one place regardless of which combat path (async attack, live rally, boss fight) produced it.

---

## 10. Summary: RPC Inventory for Volume 5

| RPC | Purpose |
|---|---|
| `train_troops` | Queue a training order (§2.2) |
| `cancel_training` | Cancel an in-flight order, partial resource refund (design-tunable %) |
| `set_formation` | Update default or per-march formation (§6.2) |
| `send_reinforcement` | Start a `marchType: 'reinforce'` march to an ally |
| `recall_reinforcement` | Recall previously sent reinforcement troops (§4.3) |
| `get_army_summary` | Garrison + Hospital + active training + active reinforcements, folded into `get_full_state`'s `army` field, replacing Volume 1's `[]` stub |

---

## Volume 5 — Summary of Deliverables for Engineering

- [ ] Migrations: `unit_config`, `unit_unlock_config`, `archetype_counter_config`; `building_level_config.secondary_stat_value` column addition for Hospital
- [ ] `training_queue` collection + completion resolution wired into `get_full_state` (extending Volume 1's aggregation point again, now three volumes deep)
- [ ] Hospital fields on `KingdomState` (`woundedTroops`, healing-tick resolve using the same lazy-resolve pattern as resources)
- [ ] `reinforcement_garrison` collection, queryable by both `targetUserId` and `sendingUserId`
- [ ] Rally participant tracking layered onto Volume 1's rally match handler skeleton
- [ ] `calculateMarchSpeed` / `calculateCarryCapacity` functions, replacing Volume 3's stubs
- [ ] `applyCasualtyReport()` — single mutation entrypoint for all combat-driven army changes
- [ ] Unity: Barracks training UI (queue view), Hospital UI, formation editor, reinforcement send/recall UI

## Explicitly deferred out of Volume 5
- Actual `CasualtyReport` computation (i.e., real damage/loss math) — Volume 6 owns the resolver; this volume only defines the report shape and what happens after it's produced
- Alliance-side reinforcement permissions (who's allowed to reinforce whom) — Volume 7
- Citadel/Crown War-specific rally rules (larger-scale multi-alliance rallies) — Volume 8
- Formation UI polish / drag-and-drop slotting — implementation detail for the Unity task above, not a design gap

---

*End of Volume 5. Volume 6 (Combat) is now fully unblocked — every input it needs (hero contributions, unit stats, archetype counters, formation priority, march-derived state) has been defined across Volumes 4-5.*