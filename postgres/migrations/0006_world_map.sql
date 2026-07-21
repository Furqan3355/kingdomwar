-- postgres/migrations/0006_world_map.sql
-- Volume 3: World Map. Deliberately uses plain Postgres tables for
-- world_tile and army_march instead of Nakama's generic storage engine
-- (which Volume 1/2 used for per-player KingdomState). Reason:
--
--   Nakama's nk.storageList() can only page through a WHOLE collection
--   (optionally scoped to one userId) — it has no server-side key-prefix
--   or range filter. A 1024x1024 shared world grid and a march-arrival
--   sweep across thousands of concurrent players are both fundamentally
--   RANGE QUERIES ("tiles between x1..x2/y1..y2", "marches with
--   arrival_tick <= now"). Doing that by paging the entire collection into
--   the JS VM and filtering in-memory does not scale. Real indexed SQL
--   range queries do. So this volume's shared/global data goes here
--   instead of Nakama storage.

-- ============================================================
-- WORLD TILES
-- ============================================================
CREATE TABLE IF NOT EXISTS world_tile (
    shard_id           INT NOT NULL REFERENCES kingdom_shard(shard_id),
    x                  INT NOT NULL,
    y                  INT NOT NULL,
    tile_type          TEXT NOT NULL DEFAULT 'empty',
        -- 'empty' | 'resource_node' | 'player_castle' | 'neutral_monster'
        -- | 'boss_monster' | 'alliance_territory'
    owner_user_id      UUID,
    owner_alliance_id  UUID,
    occupant_data      JSONB,
    last_updated_tick  BIGINT NOT NULL DEFAULT 0,
    version            BIGINT NOT NULL DEFAULT 0, -- optimistic concurrency (§2.3)
    PRIMARY KEY (shard_id, x, y)
);

-- Viewport queries ("give me tiles in this box") are the hottest read path
-- on this table by far (every client polls its visible viewport). The
-- primary key (shard_id, x, y) already gives Postgres a btree ordered by
-- x-then-y within a shard, which supports a "WHERE shard_id=$1 AND x
-- BETWEEN $2 AND $3 AND y BETWEEN $4 AND $5" range scan directly off the
-- PK — no extra index needed for that query shape.

-- Non-empty tiles are a small minority of a 1024x1024=1,048,576-tile grid
-- (most tiles are empty/unclaimed). Partial indexes below only cover
-- non-empty rows, so they stay small and fast regardless of map size:
CREATE INDEX IF NOT EXISTS idx_world_tile_owner
    ON world_tile (shard_id, owner_user_id)
    WHERE owner_user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_world_tile_type
    ON world_tile (shard_id, tile_type)
    WHERE tile_type <> 'empty';

-- ============================================================
-- ARMY MARCHES
-- ============================================================
CREATE TABLE IF NOT EXISTS army_march (
    march_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    shard_id        INT NOT NULL REFERENCES kingdom_shard(shard_id),
    user_id         UUID NOT NULL,
    march_type      TEXT NOT NULL, -- 'attack' | 'gather' | 'reinforce' | 'scout'
    origin_x        INT NOT NULL,
    origin_y        INT NOT NULL,
    target_x        INT NOT NULL,
    target_y        INT NOT NULL,
    troops          JSONB NOT NULL,
    departure_tick  BIGINT NOT NULL,
    arrival_tick    BIGINT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'marching',
        -- 'marching' | 'arrived' | 'returning' | 'completed' | 'recalled'
    resolved        BOOLEAN NOT NULL DEFAULT FALSE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- THE scaling-critical index. The arrival sweep (external cron hitting
-- sweep_march_arrivals every few seconds) runs:
--   SELECT ... FROM army_march WHERE resolved = FALSE AND arrival_tick <= $now
--   ORDER BY arrival_tick ASC LIMIT $batchSize
-- A partial index (WHERE resolved = FALSE) means its size is bounded by
-- "how many marches are CURRENTLY in flight", never by total marches ever
-- created. Whether 100 or 10,000 marches are in flight at once, this index
-- has already sorted them by arrival_tick, so the sweep query is a cheap
-- index range scan + LIMIT, not a table scan — cost stays flat as
-- concurrent march count grows.
CREATE INDEX IF NOT EXISTS idx_army_march_pending_arrival
    ON army_march (arrival_tick)
    WHERE resolved = FALSE;

-- "does this player have a march in flight" (teleport guard, §9.3) and
-- "list my active marches" (HUD) — also partial, same reasoning.
CREATE INDEX IF NOT EXISTS idx_army_march_user_active
    ON army_march (user_id)
    WHERE resolved = FALSE;

-- ============================================================
-- SCOUT REPORTS (§7.2)
-- ============================================================
CREATE TABLE IF NOT EXISTS scout_report (
    scouting_user_id       UUID NOT NULL,
    target_user_id         UUID NOT NULL,
    expires_tick            BIGINT NOT NULL,
    revealed_troops         JSONB,
    revealed_defense_stats  JSONB,
    PRIMARY KEY (scouting_user_id, target_user_id)
);

-- ============================================================
-- WORLD EVENTS (§10)
-- ============================================================
CREATE TABLE IF NOT EXISTS world_event (
    event_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    shard_id     INT NOT NULL REFERENCES kingdom_shard(shard_id),
    event_type   TEXT NOT NULL,
    start_tick   BIGINT NOT NULL,
    end_tick     BIGINT NOT NULL,
    payload      JSONB
);

CREATE INDEX IF NOT EXISTS idx_world_event_active
    ON world_event (shard_id, end_tick);