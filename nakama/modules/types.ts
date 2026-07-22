// modules/types.ts
// Data model per Volume 1, Section 7. Do not add speculative fields here —
// heroes/army-marches/inventory live in their own storage collections (§7.3).

export interface ResourceBundle {
  gold: number;
  crystal: number;
  mithril: number;
}

export interface BuildingInstance {
  buildingId: string;
  slot: string;                 // 0005: "x_y" grid coordinate (top-left corner), NOT a building_slot lookup key anymore
  level: number;
  upgradeFinishTick: number | null; // unix seconds; null if not currently upgrading
}

export interface KingdomState {
  userId: string;
  shardId: number;

  stateVersion: number;

  castleLevel: number;
  buildings: Record<string, BuildingInstance>;
  resources: ResourceBundle;
  lastCalculatedTick: number;
  army: Record<string, number>;   // unitId -> garrisoned count (Volume 5: keys are unit_config.unit_id, e.g. 'knight')
  researchLevels: Record<string, number>;
  allianceId: string | null;
  displayName: string;
  power: number;
  factionId: string; // Volume 4 custom: 'fire' | 'water' | 'earth' | 'air', assigned randomly at creation

  // --- Volume 5: Army System ---
  hospital: HospitalState;
  // Battlefield render-group size (§ Unit Size / Render Grouping). How many
  // actual troops of the same unit_id collapse into one rendered "stack".
  // Default 1 (no grouping) for every new player — Research-volume raises
  // this later (stub field only, Research itself is out of Vol5's scope).
  unitSize: number;
}

// Volume 5 §1: custom fixed roster (melee/range/elite), NOT the original
// doc's infantry/archer/cavalry/siege archetype-counter design.
export interface UnitConfigRow {
  unit_id: string;
  display_name: string;
  category: 'melee' | 'range' | 'elite';
  slot_cost: number;        // 1 normally, 3 for 'elite' — consumed everywhere a count is capped
  tier: number;
  base_attack: number;
  base_defense: number;
  base_health: number;
  attack_speed: number;             // Volume 6 combat data — unused by any Vol5 logic
  battlefield_move_speed: number;   // Volume 6 combat data — NOT world-map march speed (that's fixed, Vol3)
  train_time_seconds: number;
  train_cost_gold: number;
  train_cost_crystal: number;
  train_cost_mithril: number;
  upkeep_gold_per_hour: number;
  // Hospital heal queue (redesigned to mirror Training exactly, just
  // cheaper/faster — see 0009_hospital_queue.sql).
  heal_time_seconds: number;
  heal_cost_gold: number;
  heal_cost_crystal: number;
  heal_cost_mithril: number;
}

export interface UnitUnlockConfigRow {
  unit_id: string;
  unlock_castle_level: number;
}

// Volume 5 §3: Hospital holds wounded troops from DEFENSIVE losses only.
// Held as a field on KingdomState (not its own collection) — wounded counts
// change at the same moments as garrisoned army counts (combat resolution,
// healing), same reasoning Volume 2/3 use for keeping tightly-coupled state
// together rather than fragmenting write paths unnecessarily.
export interface HospitalState {
  woundedTroops: Record<string, number>; // unitId -> wounded count awaiting heal
}

export interface BuildingConfigRow {
  building_id: string;
  display_name: string;
  max_level: number;
  category: string;
  unlock_castle_level: number;
  resource_type: 'gold' | 'crystal' | 'mithril' | null; // Volume 2 §2.3
  effect_type: 'production' | 'storage_cap' | 'troop_capacity' | 'defense_stat' | 'defense_active' | 'utility' | 'concurrency_cap';
  footprint_width: number;   // 0005: grid tiles wide
  footprint_height: number;  // 0005: grid tiles tall
}

export interface BuildingUnlockConfigRow {
  building_id: string;
  unlock_castle_level: number;
  is_starter_building: boolean;
}

// x/y are the building's top-left grid coordinate (0005 freeform placement).
// "slot" field is kept as the storage key format ("x_y") for backward
// compatibility with how BuildingInstance keys work — it's no longer a
// lookup into building_slot, just a coordinate string.
export interface PlaceBuildingRequest {
  buildingId: string;
  x: number;
  y: number;
}

export interface BuildingLevelConfigRow {
  building_id: string;
  level: number;
  upgrade_time_seconds: number;
  cost_gold: number;
  cost_crystal: number;
  cost_mithril: number;
  production_rate: number | null;
  stat_value: number | null;           // Volume 2 §2.4: storage cap / troop capacity / defense stat
  secondary_stat_value: number | null; // Hospital: heal queue slot count (0009); other buildings: see per-row usage
}

export interface BuildingPrerequisite {
  building_id: string;
  requires_building_id: string;
  requires_level: number;
}

export interface SlotBinding {
  slot_id: string;
  building_id: string;
}

export const KINGDOM_COLLECTION = 'kingdom';
export const KINGDOM_KEY = 'state';

// Storage layer keeps costs as an object shape rather than positional args,
// so future volumes can extend it without breaking existing RPC signatures.
export interface UpgradeBuildingRequest {
  buildingId: string;
  slot: string;
}

export interface UpgradeBuildingResponse {
  ok: boolean;
  error?: string;
  building?: BuildingInstance;
  resources?: ResourceBundle;
}