# Storm of Wars–Inspired MMORTS
## Technical Design Document — Volume 9: Nakama Backend
### Unity + Nakama

*This volume is a consolidation reference, not new design — it indexes every Nakama-specific pattern established across Volumes 1-8 in one place, for engineers who need "how do we use Nakama on this project" without re-reading eight documents. Where a pattern was already fully specified elsewhere, this volume links back rather than re-deriving it.*

---

## 1. Authentication
Fully specified in Volume 1 §6. Four methods (device/email/Google/Apple), `afterAuthenticate` hook branching on new-vs-returning player, account linking via `linkX` methods against the existing session (never post-hoc merge).

## 2. RPC Endpoints (full inventory across all volumes)

| RPC | Volume | Purpose |
|---|---|---|
| `get_full_state` | 1 | Aggregated session-start read |
| `upgrade_building` | 1/2 | Generic building upgrade |
| `attack_tile` | 3/6 | Fortress attack (map-targeted, per Vol.6 Rev.2) |
| `start_march` / `recall_march` | 3 | March lifecycle |
| `teleport_castle` | 3 | Castle relocation |
| `get_world_view` | 3 | Viewport tile query |
| `level_up_hero` / `level_up_skill` / `ascend_hero` / `equip_item` / `unequip_item` / `acquire_hero` | 4 | Hero progression |
| `train_troops` / `cancel_training` / `set_formation` / `send_reinforcement` / `recall_reinforcement` | 5 | Army management |
| `get_battle_report` / `get_replay` | 6 | Combat results |
| `create_alliance` / `invite_member` / `kick_member` / `donate` / `send_help` / `claim_territory` / `start_war` | 7 | Alliance actions |
| `join_faction` | 8 | Kingdom faction assignment |

**Standing rule across all of them (Volume 1 §17, restated once for reference):** re-validate cost/state server-side, read-modify-write with version checks where shared data is involved, never trust client-submitted values for anything power-affecting.

## 3. Match Handlers
**Only one remains after Volume 6 Revision 2's removal of rallies/boss matches:** none, currently. This TDD's final design has **zero live Nakama match handlers** — every combat and economy interaction resolves via RPC against storage, per the async-first philosophy established in Volume 1 §2.3 and reinforced by Volume 6 Rev.2's removal of the one live-match use case. If a future volume reintroduces genuinely time-boxed multi-party state, this section is where it would be documented.

## 4. Authoritative Game Logic
The server-authority rule (Volume 1 §2.1) and its concrete instances: combat resolution (Volume 6), resource production (Volume 1 §5, Volume 2 §14), all cost/timer validation (every upgrade/train/ascend RPC). Summarized once here as the project's central non-negotiable, cross-referenced from every relevant volume rather than re-argued.

## 5. Chat Channels
Alliance chat via `nk.channelIdBuildGroup` (Volume 7 §8). World chat and direct messages use Nakama's other built-in channel types (`ChannelType.Room` for world/global chat, `ChannelType.DirectMessage` for 1:1) — not previously detailed since they need no custom server logic beyond channel-join permission checks.

## 6. Groups
Alliances = Nakama Groups (Volume 7 §1-2), roles mapped directly to Nakama's three built-in tiers.

## 7. Leaderboards
Every scoreboard in this TDD reuses Nakama Leaderboards rather than a custom ranking table:
- Power rankings (Volume 8 §7)
- Alliance-war scores (Volume 7 §9)
- Faction-war scores (Volume 8 §3)
- Season history archive (Volume 8 §6) — read final leaderboard state before reset, write to `season_history` Postgres table for permanent record (leaderboards themselves reset each season)

## 8. Notifications
`nk.notificationSend` used for: march arrival/attack alerts (Volume 3 §6.3), battle reports (Volume 6 §6.2), alliance invites/gifts (Volume 7). All pushed server-side at the moment of the triggering event, not polled by the client.

## 9. Storage Collections (full inventory)

| Collection | Scope | Volume | Contents |
|---|---|---|---|
| `kingdom` | per-user | 1 | Core player state |
| `army_march` | per-user | 3 | In-flight marches |
| `world_tile` | shard-global (no owner) | 3 | Map tiles |
| `hero_roster` | per-user | 4 | Owned heroes |
| `inventory` | per-user | 4 | Equipment, materials, hero shards |
| `training_queue` | per-user | 5 | In-flight troop training orders |
| `reinforcement_garrison` | keyed by target + sender | 5 | Sent reinforcements |
| `battle_report` | per-user (both sides) | 6 | Combat results |
| `battle_replay` | shared, shorter retention | 6 | Full-precision replay data |
| `scout_report` | per-player-pair | 3 | Temporary intel reveals |
| alliance-scoped (bank/tech) | keyed by groupId | 7 | Alliance shared state |
| `world_event` | shard-global | 3 | Broadcast event state |

## 10. Runtime Modules
Folder structure and language choice (TypeScript default, Go only for profiled hot paths) fully specified in Volume 1 §4.1-4.2. Every subsequent volume's server logic (`economy/`, `worldmap/`, `heroes/`, `army/`, `combat/`, `alliance/`, `kingdom/`) slots into that same structure — this volume adds `kingdom/` (Volume 8) and confirms `matches/` is now unused per §3 above.

## 11. Cron Jobs (full inventory)

| Job | Volume | Frequency |
|---|---|---|
| March-arrival sweep | 3 | Every ~10s |
| Resource-node respawn | 3 | Periodic, density-targeted |
| Boss spawn cadence | 3 | ~1-3x/day *(note: boss live-match resolution was removed per Vol.6 Rev.2 — if bosses remain as solo-attackable targets, this job still applies; if bosses are cut entirely, remove this row)* |
| Battle report/replay pruning | 6 | Daily |
| Daily reset | 1 | Daily |
| Season reset | 8 | Per season boundary |
| Citadel capture-progress decay | 8 | Periodic |

All run via the external-scheduler pattern established in Volume 1 §4.4 (Nakama has no built-in cron — a small external container/CronJob calls authenticated server-to-server RPCs on schedule).

---

## Volume 9 — Summary of Deliverables

- [ ] No new code — this volume is a documentation/onboarding deliverable
- [ ] Confirm the boss-spawn cron job's fate (kept as solo-attack content vs. cut) as a follow-up decision from Volume 6 Rev.2, since it was left ambiguous there

---
*End of Volume 9. Volume 10 (Database) performs the same consolidation exercise for the Postgres side.*
