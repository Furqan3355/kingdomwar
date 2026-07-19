# Storm of Wars–Inspired MMORTS
## Technical Design Document — Volume 11: Networking
### Unity + Nakama

*Covers protocol-level concerns that sat implicitly underneath every RPC in Volumes 1-8 but were never addressed directly: message shape, compression, prediction boundaries, and anti-cheat specifics.*

---

## 1. Message Protocol

### 1.1 Transport split (recap, now made explicit as a protocol decision)
- **RPC (HTTP/gRPC via Nakama's client)** — request/response, used for every state-changing action in this TDD (Volumes 1-8's full RPC inventory, indexed in Volume 9 §2).
- **WebSocket** — chat (Volume 7 §8), notifications (Volume 9 §8), world-event broadcast stream (Volume 3 §10.2).

### 1.2 Payload format
All RPC payloads are **JSON strings** (Nakama's native RPC payload type) — not a binary protocol like Protobuf/FlatBuffers. This is a deliberate simplicity choice for this project's scale: JSON is human-readable in logs/debugging, both Unity and Godot SDKs handle it natively, and the payload sizes involved (a `KingdomState` blob, a battle report) are small enough that binary encoding's size/parse-speed benefit isn't worth the added tooling complexity. Revisit only if profiling shows serialization overhead as a real bottleneck post-launch.

### 1.3 Envelope consistency
Every RPC response in this TDD follows the same `{ ok: boolean, error?: string, ...data }` shape (established informally from Volume 1 onward, e.g. `UpgradeBuildingResponse`, `FullStateResponse`). This section makes it a formal contract: **every new RPC must follow this envelope** so client-side response handling can share one error-checking code path rather than each RPC needing bespoke handling.

---

## 2. Serialization

### 2.1 Server-side
Nakama's TypeScript runtime uses native `JSON.parse`/`JSON.stringify` — no custom serialization layer needed given the JSON-payload decision (§1.2).

### 2.2 Client-side
Per Volume 1's flagged gotcha: Unity's `JsonUtility` cannot handle `Dictionary<TKey,TValue>` fields, which appear throughout this TDD's models (`KingdomState.buildings`, `.army`, `.researchLevels`, etc.). **Newtonsoft.Json is the mandated deserializer for every model in this project**, not just `PlayerDataService`'s original use case — this section elevates that from an implementation note (Volume 1) to a project-wide rule, since every subsequent volume's Unity-side models share the same dictionary-heavy shape.

---

## 3. Compression

### 3.1 Transport-level
WebSocket compression (permessage-deflate) should be enabled at the Nakama server config level — a one-line config flag, not application code, and reduces bandwidth for chat/notification/broadcast traffic with no client-side changes needed.

### 3.2 Payload-level
No application-level payload compression (e.g. gzipping individual RPC bodies) is recommended for launch — at this project's payload sizes (Section 1.2), the CPU cost of compress/decompress on both ends likely exceeds the bandwidth savings. Revisit only if `get_full_state` payloads grow significantly larger than expected (e.g. very large hero rosters/inventories at endgame) and profiling confirms bandwidth, not compute, is the bottleneck.

---

## 4. Client Prediction (where appropriate)

### 4.1 Restating Volume 1 §2.4's policy as the project-wide standard
Optimistic prediction is allowed **only** for latency-hiding on non-power-affecting UI feedback — building/training timer display (Volume 1 §2.4, Volume 5 §2). It is explicitly **never** applied to:
- Combat outcomes (Volume 6 §1.1 — client never computes a result, only plays back the server's)
- Resource totals (Volume 1 §2.4's original ruling)
- Plunder amounts, casualty counts, or any other combat-derived number (Volume 6 Revision 2 §3.3)

### 4.2 Reconciliation
Every prediction must have a defined rollback path on RPC failure — `PlayerDataService.UpgradeBuildingAsync` (Volume 1's implementation) is the canonical example: optimistic write → real RPC call → on failure, restore the pre-optimistic value; on success, overwrite with the server's authoritative response. Every future predicted action (e.g. Volume 5's training queue) should follow this exact pattern rather than inventing a new one.

---

## 5. Synchronization

### 5.1 No continuous sync — pull-based reconciliation
This TDD has no server-push "state sync" stream for `KingdomState` — the client's copy is only as fresh as its last `get_full_state` call or the response of its last action RPC. This is intentional given the async-first design (Volume 6 Revision 2 removed the one system — rallies — that would have justified continuous live sync). The client should call `get_full_state` (or a scoped equivalent) whenever returning to the app/reconnecting the socket, not rely on background push for correctness.

### 5.2 What *is* pushed
Only genuinely event-driven things use the socket push path: notifications (attack alerts, battle reports arriving), chat messages, and world-event broadcasts (Volume 3 §10.2). None of these require the client to reconcile complex state — they're either "go fetch the thing this notification points to" or self-contained messages (chat).

---

## 6. Anti-Cheat Validation

### 6.1 The one rule underlying everything in this document
Every piece of anti-cheat guidance in this TDD reduces to Volume 1 §2.1: **the server computes, the client displays.** This section collects the specific validation checks already specified across earlier volumes into one anti-cheat-focused list, for a security review pass:

| Check | Where specified |
|---|---|
| Cost/timer re-validation against Postgres config on every spend | Volume 1 §17 |
| Version-checked read-modify-write on all shared/world data | Volume 3 §2.3 |
| No client-submitted troop counts trusted without cross-checking storage | Volume 1 §12 (rules doc) |
| Combat resolution never accepts a client-computed outcome | Volume 6 §1.1 |
| Equipment substat rolls happen server-side only | Volume 4 §4.3 |
| New-player protection + mutual-attack-forfeiture enforced server-side | Volume 6 §9.2-9.3 |
| RPC idempotency guards against duplicate/rapid calls (e.g. double-tap) | Volume 1 §18 (rules doc) |

### 6.2 Rate limiting
Nakama supports request rate limiting at the reverse-proxy/gateway level (e.g. Nginx, covered in Volume 14) — apply per-user rate limits on high-frequency RPCs (`attack_tile`, `find_target`'s successor map-browsing calls, `train_troops`) to prevent spam-based denial-of-service or farming exploits, independent of the per-action validation logic already in place.

### 6.3 Audit logging
Every resource-affecting RPC should log (via Nakama's `logger`) the userId, action, and resulting resource delta — not for real-time blocking, but so a post-hoc anti-cheat/support investigation has a trail. This is a logging convention to apply consistently across every RPC in Volumes 1-8, not a new system.

---

## Volume 11 — Summary of Deliverables

- [ ] Enforce the `{ ok, error?, ...data }` response envelope across every RPC (retrofit any that drifted)
- [ ] Confirm Newtonsoft.Json is used for all Unity-side model deserialization, not just `PlayerDataService`
- [ ] Enable WebSocket permessage-deflate in Nakama server config
- [ ] Add per-user rate limiting at the gateway layer for high-frequency RPCs
- [ ] Add consistent audit logging to every resource-affecting RPC

---
*End of Volume 11. Volume 12 (Live Operations) covers the player-facing event/monetization layer sitting on top of everything built so far.*
