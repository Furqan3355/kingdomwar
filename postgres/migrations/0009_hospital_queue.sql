-- postgres/migrations/0009_hospital_queue.sql
-- Reworks Hospital from a passive %-of-capacity-per-hour heal (0008) into a
-- QUEUE system mirroring Training (army/training.ts): each wounded unit
-- heals over its OWN heal_time_seconds, consumes resources like training
-- does, and only as many heal orders can run at once as the Hospital has
-- queue slots (same shape as Barracks stat_value = queue slots).
--
-- Per-unit heal cost/time is cheaper than training the same unit from
-- scratch (per user's explicit call — "kam time, kam cost, training se
-- sasta"), NOT reusing train_time_seconds/train_cost_* directly.

ALTER TABLE unit_config
    ADD COLUMN IF NOT EXISTS heal_time_seconds  INT    NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS heal_cost_gold      BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS heal_cost_crystal   BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS heal_cost_mithril   BIGINT NOT NULL DEFAULT 0;

-- Roughly 40% of train time/cost per unit — cheaper & faster than training
-- fresh, since the troop already exists and is just recovering.
UPDATE unit_config SET
    heal_time_seconds = GREATEST(1, ROUND(train_time_seconds * 0.4)::INT),
    heal_cost_gold    = ROUND(train_cost_gold * 0.4),
    heal_cost_crystal = ROUND(train_cost_crystal * 0.4),
    heal_cost_mithril = ROUND(train_cost_mithril * 0.4);

-- Hospital's secondary_stat_value previously meant "heal % of capacity per
-- hour" (0008 comment). That mechanic is gone — secondary_stat_value now
-- means HEAL QUEUE SLOTS (identical convention to Barracks' stat_value =
-- training queue slots). stat_value keeps its original meaning: wounded
-- troop capacity (unchanged).
COMMENT ON COLUMN building_level_config.secondary_stat_value IS
  'Hospital: heal queue slot count (was heal %/hr pre-0009). Other buildings: see per-building comments.';

UPDATE building_level_config SET secondary_stat_value = 1 WHERE building_id = 'hospital' AND level = 1;
UPDATE building_level_config SET secondary_stat_value = 2 WHERE building_id = 'hospital' AND level = 2;
UPDATE building_level_config SET secondary_stat_value = 3 WHERE building_id = 'hospital' AND level = 3;
-- NOTE: hospital only has levels 1-3 configured in building_level_config so
-- far (pre-existing gap from 0003_building_roster.sql, not introduced by
-- this migration) — doc mentions levels 1-24, remaining levels still need
-- their own row inserts whenever Hospital's level cap is actually raised.
