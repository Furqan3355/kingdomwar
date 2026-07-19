# Storm of Wars–Inspired MMORTS
## Technical Design Document — Volume 4: Heroes
### Unity + Nakama

*Builds on Volume 1 (config pipeline, storage/collection rules), Volume 2 (Academy as the eventual research link), and Volume 3 (march speed/scouting stubs this volume fills in). Heroes are the primary account-power and monetization-adjacent progression system alongside Castle level — this volume defines them as data first, combat-formula contributors second (full formula integration lands in Volume 6).*

---

## 1. Hero Database

### 1.1 Storage split (recap of the Volume 1 §5 rule, applied here)
- **Static hero definitions** (name, base stats, rarity, skill kit) → Postgres, `hero_config` table — shared, read-heavy, designer-authored via the config pipeline.
- **Per-player hero instances** (level, XP, equipped items, ascension tier) → Nakama storage, own collection (`hero_roster`), **not embedded in `KingdomState`** — same reasoning as Volume 1 §7.3 (different write frequency than city/resource state; equipping/leveling a hero shouldn't contend with a resource-tick write).

### 1.2 `hero_config` schema
```sql
CREATE TABLE IF NOT EXISTS hero_config (
    hero_id            TEXT PRIMARY KEY,
    display_name        TEXT NOT NULL,
    rarity               TEXT NOT NULL,      -- see §2
    faction               TEXT,               -- optional flavor/synergy tag
    role                  TEXT NOT NULL,      -- 'tank' | 'damage' | 'support' | 'commander'
    base_attack          NUMERIC NOT NULL,
    base_defense          NUMERIC NOT NULL,
    base_health           NUMERIC NOT NULL,
    base_march_speed_bonus NUMERIC NOT NULL DEFAULT 0, -- feeds Volume 3 §6.2
    base_stealth          NUMERIC NOT NULL DEFAULT 0,   -- feeds Volume 3 §7.3
    acquisition_source    TEXT NOT NULL       -- 'summon' | 'event' | 'quest' — informs Volume 12 hooks, not enforced here
);
```

### 1.3 Per-player instance shape
```typescript
// modules/heroes/types.ts
export interface HeroInstance {
  heroId: string;          // references hero_config.hero_id
  instanceId: string;      // unique per copy (some games allow dupes -> shards, see §5)
  level: number;
  experience: number;
  ascensionTier: number;   // §6
  equipment: Record<string, string | null>; // slot -> item instance id, see §4
  skillLevels: Record<string, number>;      // skillId -> level, see §3
  assignedTo: 'garrison' | 'march' | null;  // where the hero currently is (Volume 5 links this to army)
}
```

Stored under collection `hero_roster`, key = `instanceId`, `userId` = owner — this one *is* per-player-scoped in the Volume 1 sense (unlike world tiles in Volume 3), so it follows the standard per-player storage pattern directly.

### 1.4 Launch roster sizing
Recommend **18-24 heroes at launch** across the rarity tiers in Section 2 — enough for team-comp variety without diluting the acquisition pool so thin that new players never complete a low-rarity roster. Exact roster content (names, kits) is design-owned data flowing through the config pipeline; this document defines the schema, not the cast.

---

## 2. Hero Rarity

### 2.1 Tiers
| Rarity | Typical acquisition | Max ascension tier (§6) | Design intent |
|---|---|---|---|
| Common | Guaranteed early quests | 2 | Onboarding, always-useful fodder for ascension fuel |
| Rare | Frequent summon result | 3 | Early-mid game core |
| Epic | Uncommon summon result | 4 | Mid-late game core, alliance-tech-gated skill unlocks |
| Legendary | Rare summon / major events | 5 | Endgame chase heroes, define team archetypes |

### 2.2 Rarity is data, not a hardcoded enum in game logic
`rarity` is a plain string column matched against a small `hero_rarity_config` table (max ascension tier, XP curve multiplier, base stat multiplier) rather than an enum baked into TypeScript — keeps the door open for a fifth tier post-launch without a code change, consistent with this TDD's general rule of pushing tunable values into config, not code (Volume 1 §9, Volume 2 §14.4).

```sql
CREATE TABLE IF NOT EXISTS hero_rarity_config (
    rarity                TEXT PRIMARY KEY,
    max_ascension_tier     INT NOT NULL,
    xp_curve_multiplier    NUMERIC NOT NULL DEFAULT 1.0,
    stat_multiplier         NUMERIC NOT NULL DEFAULT 1.0
);
```

---

## 3. Hero Skills

### 3.1 Skill data shape
Each hero has 1-4 skills, each independently levelable (separate from hero level itself — mirrors the reference genre's common "hero level" vs. "skill level" split, which lets players make meaningful choices about where to invest skill-up materials).

```sql
CREATE TABLE IF NOT EXISTS hero_skill_config (
    skill_id         TEXT PRIMARY KEY,
    hero_id           TEXT REFERENCES hero_config(hero_id),
    skill_type         TEXT NOT NULL, -- 'active_combat' | 'passive_combat' | 'march' | 'economy'
    max_level          INT NOT NULL DEFAULT 5,
    trigger_condition  TEXT            -- 'battle_start' | 'per_turn' | 'on_crit' | 'passive' — see §8
);

CREATE TABLE IF NOT EXISTS hero_skill_level_config (
    skill_id      TEXT REFERENCES hero_skill_config(skill_id),
    level         INT NOT NULL,
    effect_value  NUMERIC NOT NULL, -- interpretation depends on skill_type, same generic-stat-column
                                      -- pattern established in Volume 2 §2.4
    upgrade_cost  JSONB,             -- flexible cost shape (skill-up items vary by hero rarity)
    PRIMARY KEY (skill_id, level)
);
```

### 3.2 Why `effect_value` is a single generic column, not per-skill-type tables
Same rationale as Volume 2's `stat_value` decision: one row-per-level shape keeps the config export pipeline building-type/skill-type agnostic. A skill's *meaning* (e.g. "+X% damage to marching units" vs "+X flat defense to garrison") is resolved by code reading `skill_type` + `trigger_condition`, not by the schema having a different column per possible effect — that would require a schema migration every time design wants a new skill archetype.

### 3.3 Skill leveling economy hook
Skill-up costs (`upgrade_cost` JSONB) reference item IDs from the Equipment/materials system (Section 4) — no new economy primitive is introduced here; skill leveling spends the same inventory collection equipment does.

---

## 4. Equipment

### 4.1 Equipment vs. hero instance
Equipment is **not embedded in `HeroInstance`** — it lives in its own `inventory` collection (per Volume 1 §7.3's separation-by-write-frequency rule; equipping/unequipping shouldn't require rewriting the whole hero roster blob, and the same equipment item's *definition* is shared config while the *instance* — including any random-rolled substats — is per-player).

```typescript
export interface EquipmentInstance {
  itemInstanceId: string;
  itemId: string;        // references equipment_config
  level: number;          // equipment can be independently upgraded/enhanced
  rolledSubstats: Record<string, number>; // e.g. { crit_rate: 0.03 } — see §4.3
  equippedToHeroInstanceId: string | null;
}
```

### 4.2 `equipment_config`
```sql
CREATE TABLE IF NOT EXISTS equipment_config (
    item_id        TEXT PRIMARY KEY,
    display_name    TEXT NOT NULL,
    slot             TEXT NOT NULL,  -- 'weapon' | 'armor' | 'accessory' | 'mount'
    rarity           TEXT NOT NULL,  -- reuses hero_rarity_config tiers for consistency
    base_stat_type   TEXT NOT NULL,  -- 'attack' | 'defense' | 'health'
    base_stat_value  NUMERIC NOT NULL
);
```

### 4.3 Substat rolls
Equipment above Common rarity rolls 1-4 random substats on acquisition from a weighted pool (`equipment_substat_pool` config table — same generic pattern, omitted here for brevity since it follows §3.2's approach exactly: a pool table + a per-instance rolled-values map). Rolling happens **server-side at acquisition time**, never client-side, per the standing rule that anything affecting player power must be server-authoritative (Volume 1 §2.1).

### 4.4 Equip RPC
```typescript
export function rpcEquipItem(ctx, logger, nk, payload) {
  const req = JSON.parse(payload); // { heroInstanceId, itemInstanceId, slot }
  const userId = ctx.userId;

  const hero = readHeroInstance(nk, userId, req.heroInstanceId);
  const item = readInventoryItem(nk, userId, req.itemInstanceId);
  if (!hero || !item) return respond({ ok: false, error: 'not_found' });
  if (item.equippedToHeroInstanceId && item.equippedToHeroInstanceId !== hero.instanceId) {
    return respond({ ok: false, error: 'item_already_equipped' });
  }

  const cfg = getEquipmentConfig(nk, item.itemId);
  const previousItemId = hero.equipment[req.slot];
  if (previousItemId) {
    unequip(nk, userId, previousItemId); // auto-swap, standard UX for this genre
  }

  hero.equipment[req.slot] = item.itemInstanceId;
  item.equippedToHeroInstanceId = hero.instanceId;
  writeHeroInstance(nk, userId, hero);
  writeInventoryItem(nk, userId, item);

  return respond({ ok: true, hero });
}
```

---

## 5. Experience

### 5.1 XP sources
Hero XP is earned from: PvE combat (neutral monster/boss kills, Volume 3 §5), a consumable "hero XP item" (economy sink, ties into Volume 12 shop), and optionally a small trickle from any combat the hero participates in regardless of outcome (standard "don't punish losing too hard" design).

### 5.2 XP curve
```
xp_required(level) = base_xp * (level ^ curve_exponent) * hero_rarity_config.xp_curve_multiplier
```
Recommended `curve_exponent ≈ 2.1-2.4` — steep enough that max-level heroes represent real investment, without the flat-per-level design that makes low levels feel worthless. As with all formulas in this TDD, constants belong in config, not code (Volume 2 §14.4 rule applied here identically).

### 5.3 Level cap gating
`max_level` per hero is **not** rarity-fixed alone — it's additionally gated by `ascensionTier` (Section 6): a hero can't level past `ascension_tier * level_band` (e.g. 20 levels per ascension tier) until ascended further. This is the standard genre lever that makes ascension materials a recurring mid-game gate rather than a one-time unlock.

---

## 6. Ascension

### 6.1 Concept
A hero "breaks through" a soft level cap by consuming ascension materials (duplicate hero shards and/or ascension-specific items), which also grants a permanent stat multiplier bump — the primary long-term power lever for a hero beyond its level/skill investment.

### 6.2 Data
```sql
CREATE TABLE IF NOT EXISTS hero_ascension_config (
    hero_id             TEXT REFERENCES hero_config(hero_id),
    tier                 INT NOT NULL,
    required_shards       INT NOT NULL,
    required_items        JSONB,          -- flexible material cost, same pattern as §3.1's upgrade_cost
    stat_multiplier_bonus NUMERIC NOT NULL, -- additive to base stat_multiplier from rarity config
    unlocks_level_cap      INT NOT NULL,
    PRIMARY KEY (hero_id, tier)
);
```

### 6.3 Duplicate heroes → shards
When a player acquires a hero they already own (Section 1.3 mentions `instanceId` supporting duplicates — this is why): the acquisition RPC converts the duplicate into `hero_shard` currency (a simple entry in the `inventory` collection, itemId = `shard_{heroId}`) rather than creating a second `HeroInstance`. This is the standard, player-friendly resolution to "I got a hero I already have" and keeps `hero_roster` free of confusing duplicate entries.

### 6.4 Ascension RPC validation
Same shape as Volume 2's building-upgrade validation: re-check material counts server-side against `inventory`, re-check `required_shards`/`required_items` against `hero_ascension_config`, apply atomically, never trust a client-submitted "I have enough materials" claim.

---

## 7. Hero AI

### 7.1 Scope clarification
"Hero AI" in this genre does **not** mean autonomous hero movement or decision-making on the world map — heroes are always attached to a player-controlled army or garrison (Volume 5 territory) and never act independently outside combat. "Hero AI" here specifically means **in-combat skill activation logic** for the server-authoritative combat resolver (Volume 6) — i.e., the deterministic rules governing *when* a hero's active skill triggers during a resolved battle.

### 7.2 Activation model
Combat in this TDD is **not turn-by-turn player input** (§1.4 of Volume 1 explicitly rules out twitch/skill-based combat) — it's a formula resolution. Hero AI is therefore a fixed, deterministic decision table evaluated once during combat resolution, not a runtime AI system:

```typescript
interface HeroActivationRule {
  skillId: string;
  triggerCondition: 'battle_start' | 'every_n_seconds' | 'below_health_threshold' | 'on_ally_death';
  triggerParam: number | null; // e.g. n for every_n_seconds, threshold % for health-based
  priority: number; // resolves ties when multiple heroes' skills would trigger the same tick
}
```

### 7.3 Determinism requirement
Because combat is server-authoritative and battle reports must be **replayable** (Volume 6 will define replay data), hero skill activation must be a pure function of battle state at each resolution tick — no random rolls inside activation logic itself (randomness, where used at all, is seeded once at battle start and consumed deterministically, so the same seed always reproduces the same battle for replay purposes).

---

## 8. Hero Combat Formulas

### 8.1 Scope for Volume 4
Full combat resolution (troop vs. troop, hero contribution weighting, buffs/debuffs, critical hits) is Volume 6's responsibility. This volume defines **how a hero's own stats are computed** going into that resolver — the input, not the resolution algorithm itself.

### 8.2 Effective hero stat formula
```
effective_stat(hero, statType) =
    hero_config.base_stat
    * hero_rarity_config.stat_multiplier
    * (1 + sum(ascension.stat_multiplier_bonus for tier in 1..ascensionTier))
    * level_scaling(hero.level)
    + sum(equipment.base_stat_value where base_stat_type == statType)
    + sum(equipment.rolledSubstats[statType] contributions)
```

```typescript
function level_scaling(level: number): number {
  // Diminishing-returns curve — keeps stat growth meaningful at every level
  // without letting a maxed low-rarity hero out-scale a fresh legendary.
  return 1 + 0.08 * (level - 1);
}
```

### 8.3 Hero contribution to army power
A hero assigned to a march or garrison (Volume 5 links `HeroInstance.assignedTo`) contributes its `effective_stat` values as flat bonuses to that army's aggregate combat stats, weighted by the hero's `role` (Section 1.2): `tank` heroes weight toward defense/health, `damage` toward attack, `support`/`commander` primarily contribute skill effects (Section 3) rather than raw stat weight. Exact weighting coefficients are config-tunable, following the same "formula shape in code, constants in config" boundary established in Volume 2 §14.4.

### 8.4 This volume's output contract for Volume 6
Volume 6's combat resolver expects, per participating hero, a single computed object:
```typescript
interface HeroCombatContribution {
  heroInstanceId: string;
  attack: number;
  defense: number;
  health: number;
  activationRules: HeroActivationRule[]; // from §7.2
}
```
This is the seam between the two volumes — Volume 4 owns everything that produces this object; Volume 6 owns everything that consumes it.

---

## 9. Summary: RPC Inventory for Volume 4

| RPC | Purpose |
|---|---|
| `get_hero_roster` | List player's owned heroes (folded into `get_full_state`'s `heroes` field, replacing Volume 1's stub) |
| `level_up_hero` | Spend XP items/consume battle XP, validate against `hero_rarity_config` curve |
| `level_up_skill` | Spend skill materials, validate against `hero_skill_level_config` |
| `ascend_hero` | Consume shards/materials, validate against `hero_ascension_config` (§6.4) |
| `equip_item` | Equip/auto-swap equipment (§4.4) |
| `unequip_item` | Remove equipment back to inventory |
| `acquire_hero` | Entry point from summon/quest/event systems (Volume 12 hooks in here) — handles duplicate→shard conversion (§6.3) |

---

## Volume 4 — Summary of Deliverables for Engineering

- [ ] Migrations: `hero_config`, `hero_rarity_config`, `hero_skill_config`, `hero_skill_level_config`, `equipment_config`, `equipment_substat_pool`, `hero_ascension_config`
- [ ] `hero_roster` and equipment-aware `inventory` storage collections
- [ ] `get_full_state` extended: replace Volume 1's `heroes: []` stub with real roster data
- [ ] Full RPC set from Section 9, each with server-side validation matching the pattern established in Volume 1 §17/Volume 2's building-upgrade checks
- [ ] `effective_stat` calculation function (§8.2) and `HeroCombatContribution` builder (§8.4) — pure functions, unit-testable independent of Volume 6's resolver
- [ ] Launch hero roster seed data (18-24 heroes) via the config export pipeline
- [ ] Unity: hero roster screen, hero detail panel (level/skill/ascension/equipment tabs), inventory/equipment screen

## Explicitly deferred out of Volume 4
- Actual combat resolution consuming `HeroCombatContribution` (Volume 6)
- Hero assignment to marches/garrisons as a first-class Army-system concept (Volume 5 owns `assignedTo` semantics beyond the field existing)
- Summon gacha mechanics and rates (Volume 12 — `acquire_hero` is a plain entry point, not a gacha implementation)
- March speed/stealth bonuses (`base_march_speed_bonus`, `base_stealth` columns exist and are referenced by Volume 3, but the aggregation logic that applies them to an actual march lives in Volume 5)

---

*End of Volume 4. Volume 5 (Army System) is the natural next volume — it's referenced throughout this document (`assignedTo`, march speed/carry capacity, garrison composition) and several Volume 3 stubs are also waiting on it.*