# Storm of Wars–Inspired MMORTS
## Technical Design Document — Volume 7: Alliance System
### Unity + Nakama

*Builds on Nakama's built-in Groups feature (flagged as the right fit back in Volume 1 §4.3). Fills every Embassy hook left open in Volume 2 §11, and redefines "alliance war" per Volume 6 Revision 2's removal of rallies: wars are now aggregated individual fortress-attack outcomes, not combined armies.*

---

## 1. Alliance Creation

Alliances map directly onto Nakama **Groups**: `nk.groupCreate(userId, name, creatorUserId, langTag, description, avatarUrl, open, maxCount, metadata)`. `maxCount` recommended at 50-100 for launch. Creation costs a small gold fee (economy sink) validated the same way any resource-spending RPC is (Volume 1 §17).

```typescript
export function rpcCreateAlliance(ctx, logger, nk, payload) {
  const req = JSON.parse(payload); // { name, description, open }
  const kingdom = readAndResolveKingdomState(nk, ctx.userId);
  if (kingdom.allianceId) return respond({ ok: false, error: 'already_in_alliance' });
  if (kingdom.resources.gold < ALLIANCE_CREATE_COST) return respond({ ok: false, error: 'insufficient_resources' });

  const group = nk.groupCreate(ctx.userId, req.name, ctx.userId, '', req.description, '', req.open, 100, {});
  kingdom.resources.gold -= ALLIANCE_CREATE_COST;
  kingdom.allianceId = group.id;
  writeKingdomState(nk, ctx.userId, kingdom);
  return respond({ ok: true, allianceId: group.id });
}
```

---

## 2. Roles

Nakama Groups ship three built-in roles (superadmin, admin, member) — map directly to **Leader, Officer, Member**. No custom role table needed; role-gated actions (Sections 4-7) check `nk.groupUsersList` membership state before allowing the action.

| Nakama role | Alliance role | Can do |
|---|---|---|
| Superadmin | Leader | Everything below, plus disband alliance, transfer leadership |
| Admin | Officer | Invite/kick members, start territory claims, manage alliance tech votes |
| Member | Member | Donate, request help, view territory, participate in chat |

---

## 3. Technology

Alliance-wide passive bonuses (production %, combat stat %) funded by member donations — same generic-stat-column pattern used throughout this TDD (Volume 2 §2.4, Volume 4 §3.2):

```sql
CREATE TABLE IF NOT EXISTS alliance_tech_config (
    tech_id        TEXT PRIMARY KEY,
    display_name    TEXT NOT NULL,
    max_level        INT NOT NULL,
    effect_type       TEXT NOT NULL -- 'production_bonus' | 'combat_bonus' | 'march_speed_bonus'
);
CREATE TABLE IF NOT EXISTS alliance_tech_level_config (
    tech_id        TEXT REFERENCES alliance_tech_config(tech_id),
    level          INT NOT NULL,
    cost_resources  JSONB NOT NULL, -- pooled alliance-bank cost, not one player's
    effect_value    NUMERIC NOT NULL,
    PRIMARY KEY (tech_id, level)
);
```
Alliance-owned state (current tech levels, bank balance) lives in a storage collection keyed by `groupId` (not `userId`) — same "shared data, no owner" pattern established for world tiles in Volume 3 §2.1.

---

## 4. Gifts

Officers/Leaders can trigger a "gift request" broadcast (via the alliance's Nakama chat channel, §8) that members tap to contribute a small resource amount toward the requester — lightweight social-engagement feature, implemented as a short-lived storage object (`alliance_gift`, TTL-style expiry checked on read) rather than a persistent system.

---

## 5. Help Requests

Building-upgrade and troop-training timers (Volumes 2 and 5) can be reduced by alliance member "helps" — each help shaves a fixed or percentage amount off the current `upgradeFinishTick`/training order's `finishTick`. Implemented as an RPC (`send_help`) that validates the target request is still active, then subtracts time and re-writes — same version-checked read-modify-write discipline as every other timer mutation in this TDD (Volume 1 §17).

---

## 6. Territory

### 6.1 Alliance territory claims
Extends Volume 3 §3.1's `alliance_territory` tile type (was a hook only). A territory claim is an officer/leader-initiated action requiring adjacency to an already-owned tile (or the alliance's first claim, unconstrained) — validated server-side, version-checked exactly like `claimTile` in Volume 3 §2.3.

### 6.2 Territory benefits
Members with a castle inside alliance territory get a small passive bonus (production or defense, reusing the `CombatModifier`/production-rate stacking patterns already defined) — the mechanism is additive to existing per-player calculations, not a new resolver path.

---

## 7. Alliance Buildings

Completes Volume 2 §11's Embassy shell: Embassy hosts alliance actions (donate, help requests, territory claim initiation) as its city-side UI entry point. No new building type is needed — Embassy *is* the alliance-buildings hook; a separate "alliance-only building placed on alliance territory" (e.g. a shared alliance fortress) is a reasonable post-launch addition but out of scope here.

---

## 8. Alliance Chat

Nakama's realtime chat channels attach natively to groups (flagged in Volume 1 §4.3) — `nk.channelIdBuildGroup(groupId)` gives a channel ID clients join over the socket connection already established in Volume 1's `NakamaClientService`. No custom message-routing code needed; this is close to zero-effort given Nakama's built-in support.

---

## 9. Alliance Wars (redefined per Volume 6 Revision 2)

Since rallies/combined-force combat are removed, "alliance war" is a **shared scoreboard of individual fortress-attack outcomes**, not a combined-army battle:

```typescript
interface AllianceWar {
  warId: string;
  allianceAId: string;
  allianceBId: string;
  startTick: number;
  endTick: number;
  scoreA: number;
  scoreB: number;
}
```
Every `resolveCombat` result (Volume 6) where attacker and defender belong to opposing warring alliances contributes points to the war scoreboard (via a Nakama Leaderboard scoped to `warId`, per Volume 1 §4.3's leaderboard-for-war-scoreboards note) — no new combat mechanic, just a scoring hook on the existing single-attacker resolution path.

---

## Volume 7 — Summary of Deliverables

- [ ] `create_alliance`, `invite_member`, `kick_member`, `donate`, `send_help`, `claim_territory`, `start_war`, RPCs
- [ ] `alliance_tech_config`/`alliance_tech_level_config` tables + alliance-scoped storage collection (bank, tech levels)
- [ ] Territory claim logic reusing Volume 3's version-checked tile-claim pattern
- [ ] `AllianceWar` + war-scoped Nakama Leaderboard wiring into `resolveCombat`'s output
- [ ] Unity: alliance screen (roster/roles), tech tree UI, territory map overlay, chat panel

## Explicitly deferred
- Dedicated alliance-built structures beyond Embassy (post-launch candidate)
- Cross-shard alliance mechanics (Volume 8 territory)

---
*End of Volume 7. Volume 8 (Kingdom Systems) is next — it defines the shard lifecycle and larger-scale seasonal war structures that alliance wars (§9) plug into.*
