# Storm of Wars–Inspired MMORTS
## Technical Design Document — Volume 10: Database
### Unity + Nakama

*Consolidates every custom Postgres table introduced across Volumes 1-8 into one schema reference, plus indexing/transaction/migration/backup guidance not previously centralized.*

---

## 1. Complete PostgreSQL Schema (custom tables only — Nakama's own schema is out of scope)

```sql
-- Volume 1: Core
building_config(building_id PK, display_name, max_level, category, unlock_castle_level,
                 resource_type, effect_type)                       -- resource_type/effect_type added Vol.2
building_level_config(building_id FK, level, upgrade_time_seconds, cost_gold, cost_crystal,
                       cost_mithril, production_rate, stat_value, secondary_stat_value)  -- Vol.2/Vol.5
kingdom_shard(shard_id PK, shard_name, opened_at, closes_at, status)
player_shard_membership(user_id, shard_id FK)

-- Volume 2: City
building_prerequisite(building_id FK, requires_building_id FK, requires_level)
building_slot(slot_id PK, building_id FK)

-- Volume 4: Heroes
hero_config(hero_id PK, display_name, rarity, faction, role, base_attack, base_defense,
            base_health, base_march_speed_bonus, base_stealth, acquisition_source)
hero_rarity_config(rarity PK, max_ascension_tier, xp_curve_multiplier, stat_multiplier)
hero_skill_config(skill_id PK, hero_id FK, skill_type, max_level, trigger_condition)
hero_skill_level_config(skill_id FK, level, effect_value, upgrade_cost)
equipment_config(item_id PK, display_name, slot, rarity, base_stat_type, base_stat_value)
equipment_substat_pool(...)                                          -- weighted roll table, Vol.4 §4.3
hero_ascension_config(hero_id FK, tier, required_shards, required_items,
                       stat_multiplier_bonus, unlocks_level_cap)

-- Volume 5: Army
unit_config(unit_id PK, display_name, archetype, tier, base_attack, base_defense, base_health,
            base_march_speed, base_carry_capacity, train_time_seconds, train_cost_gold,
            train_cost_crystal, train_cost_mithril, upkeep_gold_per_hour)
unit_unlock_config(unit_id FK, unlock_castle_level)
archetype_counter_config(attacker_archetype, defender_archetype, damage_multiplier)

-- Volume 6 Rev.2: Combat / Factions
faction_config(faction_id PK, display_name, unique_ability_category)

-- Volume 7: Alliance
alliance_tech_config(tech_id PK, display_name, max_level, effect_type)
alliance_tech_level_config(tech_id FK, level, cost_resources, effect_value)

-- Volume 8: Kingdom
kingdom_merge(merge_id PK, shard_id_from FK, shard_id_into FK, scheduled_tick, status)
season_history(season_id PK, shard_id FK, final_standings JSONB, crown_faction_id, archived_at)
```

**Note:** `kingdom_power_index` (introduced in Volume 6 Revision 1 for matchmaking) is explicitly **excluded** here — Revision 2 removed the Find/matchmaking feature it supported. Do not create this table.

---

## 2. ER Diagram (textual — key relationships)

```
building_config ─┬─< building_level_config
                  ├─< building_prerequisite (self-referencing via requires_building_id)
                  └─< building_slot

hero_config ─┬─< hero_skill_config ─< hero_skill_level_config
             ├─< hero_ascension_config
             └── faction_config (many-to-one via hero_config.faction)

unit_config ─┬─< unit_unlock_config
             └── archetype_counter_config (many-to-many via archetype string, not a strict FK)

kingdom_shard ─┬─< player_shard_membership
               ├─< kingdom_merge (as either shard_id_from or shard_id_into)
               └─< season_history
```

All per-player mutable state (KingdomState, hero roster, inventory, marches, etc.) lives in **Nakama storage**, not these tables — per the storage/Postgres split rule established in Volume 1 §5 and reapplied consistently through every subsequent volume. This ER diagram intentionally shows only the *config/relational* side of the schema.

---

## 3. Indexing

Beyond primary keys, indexes actually justified by query patterns established across the volumes:

```sql
CREATE INDEX IF NOT EXISTS idx_player_shard_membership_shard ON player_shard_membership(shard_id);
CREATE INDEX IF NOT EXISTS idx_hero_skill_config_hero ON hero_skill_config(hero_id);
CREATE INDEX IF NOT EXISTS idx_unit_unlock_config_unit ON unit_unlock_config(unit_id);
CREATE INDEX IF NOT EXISTS idx_kingdom_merge_status ON kingdom_merge(status) WHERE status != 'complete';
```
General rule applied: index columns used in `WHERE`/`JOIN` on tables queried at request-time (not just admin-tooling tables, which can tolerate a sequential scan given their small, mostly-static size).

---

## 4. Transactions

Every multi-row write in this schema (e.g. seeding a building's full level curve, Volume 8's merge conflict-resolution pass) should be wrapped in an explicit transaction so a partial failure can't leave config data half-seeded:

```sql
BEGIN;
  INSERT INTO building_config (...) VALUES (...);
  INSERT INTO building_level_config (...) VALUES (...), (...), (...);
COMMIT;
```
Nakama's own per-player storage writes (`nk.storageWrite`) have their own atomicity guarantees at the storage-engine level (Volume 1 §17's read-modify-write-with-version-check pattern) — this section's transaction guidance applies specifically to the custom Postgres tables above, not to storage-collection RPC logic.

---

## 5. Migrations

Volume 1 §5/Volume 1's `apply_custom_migrations.sh` established the pattern: numbered SQL files in `postgres/migrations/`, applied via a small script since Nakama's own `migrate up` doesn't touch custom tables. Each subsequent volume's schema additions (Section 1's `ALTER TABLE` statements from Volumes 2, 5) become their own numbered migration file:

```
postgres/migrations/
├── 0001_init.sql                    (Volume 1)
├── 0002_city_system.sql             (Volume 2: resource_type/effect_type/stat_value + prereq/slot tables)
├── 0003_heroes.sql                  (Volume 4)
├── 0004_army.sql                    (Volume 5: unit tables + secondary_stat_value)
├── 0005_factions.sql                (Volume 6 Rev.2: faction_config, hero_config.faction)
├── 0006_alliance.sql                (Volume 7)
└── 0007_kingdom_systems.sql         (Volume 8)
```

---

## 6. Backup Strategy

- **Nakama's own database** (player state, world tiles, etc.) — this is the system of record for everything gameplay-critical. Recommend continuous WAL archiving (CockroachDB's built-in backup scheduling, or `pg_basebackup` + WAL shipping if running plain Postgres) with point-in-time recovery, not just nightly dumps — losing hours of player progress on restore is unacceptable for a live game.
- **Custom config tables** (Section 1) — lower risk (re-derivable from the ScriptableObject export pipeline, Volume 1 §9), but still worth including in the same backup sweep for restore-time simplicity (one restore procedure, not two).
- **Retention:** daily backups retained 30 days, weekly retained 6 months, matches typical live-service practice — exact numbers are an ops/cost decision, not an engineering constraint from this TDD.

---

## Volume 10 — Summary of Deliverables

- [ ] Consolidated migration set (Section 5's file list) applied in order on fresh environments
- [ ] Indexes from Section 3 applied
- [ ] Backup/PITR configured on the CockroachDB (or Postgres) instance per Section 6, verified with an actual restore drill before launch — an untested backup is not a backup

---
*End of Volume 10. This closes the "backend consolidation" pair (Volumes 9-10). Volume 11 (Networking) covers protocol-level concerns not yet addressed: serialization, compression, anti-cheat validation specifics.*
