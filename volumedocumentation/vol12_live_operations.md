# Storm of Wars–Inspired MMORTS
## Technical Design Document — Volume 12: Live Operations
### Unity + Nakama

*Fills every "Volume 12" forward-reference scattered across Volumes 1-11 (speedup items, shop, gacha rates, event content) and adds the operational tooling (analytics, logging, monitoring, scaling) needed to run the game post-launch.*

---

## 1. Daily Events

Lightweight recurring objectives (e.g. "train 50 troops today," "win 3 fortress attacks") tracked via a per-player `daily_progress` storage collection, reset by the same external-scheduler daily-reset job referenced since Volume 1 §4.4. Rewards are simple inventory grants (Volume 4 §4.1's existing write path).

---

## 2. Limited-Time Events

### 2.1 Mechanism (already built)
Volume 3 §10's `world_event`/broadcast-stream mechanism is the delivery layer — this section defines actual event *content* types on top of it: resource-node spawn-rate multipliers, temporary faction-war score multipliers (Volume 8 §3), themed boss spawns (pending the boss-fate decision flagged in Volume 9 §11).

### 2.2 Data
```sql
CREATE TABLE IF NOT EXISTS event_config (
    event_id       TEXT PRIMARY KEY,
    display_name    TEXT NOT NULL,
    event_type       TEXT NOT NULL, -- 'resource_bonus' | 'training_discount' | 'pvp_bonus_score' | ...
    effect_value     NUMERIC,
    starts_at         TIMESTAMPTZ NOT NULL,
    ends_at           TIMESTAMPTZ NOT NULL
);
```
Events are authored data (via an admin tool or direct DB entry, not a player-facing RPC) — the external scheduler checks `event_config` on each tick and publishes to the Volume 3 §10.2 broadcast stream when an event's `starts_at`/`ends_at` window opens/closes.

---

## 3. Reward Systems

Unifies every reward-granting path already built (daily events §1, alliance gifts Volume 7 §4, season rewards Volume 8 §8, PvE loot Volume 3 §5.1) behind one internal function:

```typescript
export function grantReward(nk: nkruntime.Nakama, userId: string, reward: RewardBundle): void {
  // Single entrypoint for every system that grants resources/items/heroes,
  // so reward-granting logic (and its audit logging, per Volume 11 §6.3)
  // lives in one place instead of being reimplemented per feature.
}
```

---

## 4. Shop

### 4.1 Structure
Standard IAP-adjacent shop: resource packs, speedup items (the mechanism Volume 2 §13.2 explicitly reserved without implementing), cosmetic items, and hero-summon currency. Real-money purchases go through platform billing (Apple/Google/Steam), validated server-side via Nakama's or the platform's receipt-verification flow before `grantReward` (§3) executes — **never grant a purchase reward before server-side receipt verification succeeds.**

### 4.2 Speedup item consumption
Delivers on Volume 2 §13.2's hook exactly as specified there: `apply_speedup` RPC reads the target `BuildingInstance`/`TrainingOrder`, subtracts seconds from its `*FinishTick`, re-writes — no change needed to the upgrade/training logic itself.

---

## 5. Battle Pass

Season-scoped (aligned with Volume 8 §6's season boundaries) progression track: a `battle_pass_progress` collection (XP counter + claimed-tier bitmap) per player, XP earned from a configurable set of actions (combat wins, building completions, daily events), tiers claimed via a `claim_battle_pass_tier` RPC that validates XP threshold and un-claimed status before calling `grantReward`.

---

## 6. Analytics

### 6.1 Event stream
Every significant player action (already logged for audit per Volume 11 §6.3) is additionally emitted to an analytics pipeline — recommend Nakama's built-in event hooks or a lightweight fire-and-forget HTTP call from runtime modules to an external analytics ingestion endpoint (e.g. a managed service or self-hosted ClickHouse/PostHog), kept **decoupled from the request's critical path** (fire-and-forget, not blocking the RPC response) so analytics ingestion issues never affect gameplay latency.

### 6.2 Key funnels to track
New-player onboarding completion (Volume 1 §6.4 → first building upgrade → first fortress attack), retention cohorts, shop conversion (§4), and season engagement (Volume 8) — standard live-service KPIs, listed here so engineering knows which actions need reliable event emission from day one rather than being retrofitted later.

---

## 7. Logging

Extends Volume 11 §6.3's audit-logging convention project-wide: structured (JSON) logs from every runtime module, tagged with `userId`, `action`, `shardId` where applicable, shipped to a centralized log aggregator (e.g. Loki, CloudWatch, or equivalent) rather than left in container stdout only — necessary for the multi-node clustered deployment described in Volume 14.

---

## 8. Monitoring

- **Application metrics** — Nakama exposes Prometheus metrics natively (mentioned as optional in Volume 1 §3's docker-compose sketch — this volume makes it a requirement, not optional, for production). Key dashboards: RPC latency/error rate per endpoint, active session count, storage read/write throughput.
- **Business metrics** — derived from the analytics stream (§6), not application metrics: DAU/MAU, session length, shop conversion — a separate dashboard audience (product/live-ops) from the engineering-facing application metrics.
- **Alerting** — RPC error-rate spikes, external-scheduler job failures (march-arrival sweep, daily reset — a missed run of these has direct gameplay impact, e.g. defenders not getting notified), database connection pool exhaustion.

---

## 9. Server Scaling

### 9.1 Recap and extension of Volume 1 §11
Nakama nodes are stateless and cluster natively (Volume 1 §11) — this volume adds the operational trigger conditions: scale out when RPC p99 latency or CPU utilization crosses a threshold, not on a fixed schedule. Since Volume 6 Revision 2 removed all live match handlers, there's no per-match CPU-affinity concern to plan around — every node is interchangeable for RPC traffic, simplifying horizontal scaling compared to a design with active match handlers.

### 9.2 Database scaling
The database (CockroachDB per Volume 1's docker-compose) is the more likely bottleneck at scale than Nakama itself, given the storage-heavy read/write pattern this TDD relies on throughout (lazy-resolve reads on nearly every RPC). Plan for read replicas / multi-node CockroachDB clustering before Nakama node count becomes the limiting factor — this ordering (DB scaling first) is worth flagging explicitly since it's counter to the instinct to scale the application layer first.

---

## Volume 12 — Summary of Deliverables

- [ ] `event_config` table + scheduler integration with the Volume 3 §10.2 broadcast stream
- [ ] `grantReward` unified reward function, retrofitted into every existing reward-granting path
- [ ] Shop RPCs + server-side receipt verification (platform-specific, before any `grantReward` call)
- [ ] `apply_speedup` RPC (finally implementing Volume 2 §13.2's hook)
- [ ] Battle pass progress tracking + tier-claim RPC
- [ ] Analytics event emission wired into every significant player action, decoupled from RPC critical path
- [ ] Centralized structured logging + Prometheus dashboards + alerting on the specific failure modes in §8
- [ ] Database scaling plan prioritized ahead of application-layer scaling per §9.2

---
*End of Volume 12. Volume 13 (Unity Project) returns to client-side concerns — folder structure, managers, and UI framework — now that every system it needs to build UI for has been fully specified.*
