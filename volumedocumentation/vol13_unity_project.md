# Storm of Wars–Inspired MMORTS
## Technical Design Document — Volume 13: Unity Project
### Unity + Nakama

*Volume 1 §3 established the base folder structure, MVVM pattern, and scene flow. This volume expands it now that every gameplay system (Volumes 2-8) and client-facing concern (Volume 11's Newtonsoft rule) is fully specified — covers managers, UI framework, and asset pipeline concerns not yet addressed.*

---

## 1. Folder Structure (expanded from Volume 1 §3)

```
Assets/_Project/Scripts/
├── Core/                  (Services locator, Volume 1)
├── Networking/             (NakamaClientService, Volume 1; extended for Volume 11's envelope handling)
├── City/                  (CityGridController, BuildingSlotView, Volume 2)
├── WorldMap/               (map viewport rendering, target selection — Volume 3, Volume 6 Rev.2)
├── Heroes/                 (roster, equipment, ascension UI — Volume 4)
├── Army/                   (training queue, hospital, formation UI — Volume 5)
├── Combat/                 (battle report + replay playback — Volume 6)
├── Alliance/                (roster, tech tree, territory overlay — Volume 7)
├── Kingdom/                 (faction selection, citadel map, season rankings — Volume 8, new in this volume)
├── LiveOps/                  (shop, battle pass, event banners — Volume 12, new in this volume)
├── UI/
│   ├── Screens/              (one folder per full-screen view)
│   ├── Widgets/              (reusable components: resource bar, progress timer, buttons)
│   └── MVVM/                  (base ViewModel classes, binding helpers)
├── Data/                    (all model classes mirroring server types, per Volume 11 §2.2's Newtonsoft rule)
├── Managers/                 (§3 below — new in this volume)
└── Utils/
```

---

## 2. Script Architecture (recap + this volume's additions)

MVVM + lightweight service locator remains the standing pattern (Volume 1 §3.1, Volume 1 rules-doc §8: no DI framework without explicit sign-off). This volume's addition: a **Manager** layer sitting between `Services` (data/networking) and the View layer, owning cross-screen orchestration that doesn't belong in any single screen's ViewModel.

---

## 3. Managers

| Manager | Owns |
|---|---|
| `SceneFlowManager` | Boot→City transitions (Volume 1 §3.2), additive WorldMap/City scene loading |
| `NotificationManager` | Receives Nakama push notifications (Volume 9 §8), routes to in-app toast/badge UI |
| `TimerManager` | Central ticking clock for every `*FinishTick` display across City/Army/Heroes screens — one `Update()` loop driving all countdown UI, instead of each screen polling independently |
| `EventBannerManager` | Subscribes to the Volume 3 §10.2 world-event stream, surfaces active events (Volume 12 §2) as banners |
| `AudioManager` | Music/SFX playback, described further in §9 |

`TimerManager` in particular is worth calling out: with building upgrades (Vol.2), training queues (Vol.5), march arrivals (Vol.3), and battle-pass/event countdowns (Vol.12) all needing live countdown display, a single shared ticking source avoids N independent `Update()` loops doing redundant `DateTimeOffset.UtcNow` math across the whole UI.

---

## 4. UI Framework

### 4.1 MVVM binding approach
No third-party MVVM framework (e.g. UniRx/MVVMLight) mandated — plain C# events (`Action`/`event` per Volume 1's `PlayerDataService.OnStateChanged` pattern) are sufficient at this project's UI complexity and keep the dependency footprint low, consistent with the "no framework without sign-off" rule.

### 4.2 Screen composition
Every full-screen view (`CityScreen`, `WorldMapScreen`, `HeroRosterScreen`, `AllianceScreen`, etc.) follows: a `*View` (MonoBehaviour, pure rendering + input forwarding) and a `*ViewModel` (plain C# class, holds the screen's local state, subscribes to relevant `Services.*` events). This mirrors `BuildingDetailPanel`'s implied shape from Volume 2 §1.1 — this volume just names the pattern explicitly for every subsequent screen.

---

## 5. Addressables

Recommend **Addressables** (not raw `Resources.Load` or manually-managed asset bundles) for all building/hero/unit visual assets — lets the large eventual content set (12+ buildings, 18-24+ heroes, faction-themed art per Vol.6 Rev.2 §4) load on-demand per screen rather than bloating initial app size. Addressable group boundaries should mirror the folder structure in Section 1 (one group per major system) for straightforward incremental content updates without full app resubmission on mobile platforms.

---

## 6. Asset Bundles

Given Addressables' adoption (§5), raw Asset Bundles are not used directly — Addressables manages bundle creation/versioning internally. This section exists only to confirm that decision explicitly rather than leaving it ambiguous.

---

## 7. Localization

Use Unity's **Localization package** (`com.unity.localization`) with string tables keyed by the same IDs already flowing through the config pipeline (`hero_id`, `building_id`, `unit_id`, `skill_id`) — `display_name` columns across Volumes 2/4/5 become localization keys rather than hardcoded display strings, so translated builds don't require touching gameplay config tables at all.

---

## 8. Audio

`AudioManager` (§3) exposes simple `PlaySfx(id)`/`PlayMusic(id)` calls; sound-effect triggers hook into existing UI/gameplay events already defined (building upgrade complete, battle report arrival, alliance gift received) rather than needing new event plumbing — audio is a pure listener on state already changing for other reasons.

---

## 9. VFX

Combat replay playback (Volume 6 §7.3 — "purely animate the already-resolved `rounds` array") is the primary VFX consumer: each `RoundResult` drives a scripted VFX sequence (damage numbers, hit effects) timed against the replay's round-by-round data, not simulated independently — this keeps VFX timing deterministic and matched to the actual resolved outcome rather than a separately-approximated animation.

---

## Volume 13 — Summary of Deliverables

- [ ] Full folder structure (Section 1) scaffolded, including the new `Kingdom/` and `LiveOps/` script folders
- [ ] `TimerManager`, `NotificationManager`, `EventBannerManager`, `AudioManager`, `SceneFlowManager` implemented
- [ ] Addressables groups configured per major system, replacing any direct `Resources.Load` calls
- [ ] Localization string tables seeded from existing config `display_name` columns
- [ ] Combat replay VFX sequencing driven directly by `RoundResult` data (Volume 6 §7)

---
*End of Volume 13. Volume 14 (Deployment) is the final volume — infrastructure and CI/CD for shipping everything specified across this TDD.*
