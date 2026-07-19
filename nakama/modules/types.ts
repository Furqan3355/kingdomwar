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
  slot: string;                 // city grid position identifier, e.g. "3_2"
  level: number;
  upgradeFinishTick: number | null; // unix seconds; null if not currently upgrading
}

export interface KingdomState {
  userId: string;
  shardId: number;
  castleLevel: number;
  buildings: Record<string, BuildingInstance>; // keyed by `${buildingId}:${slot}`
  resources: ResourceBundle;
  lastCalculatedTick: number;   // unix seconds, for lazy production resolve
  army: Record<string, number>; // unitId -> count, garrisoned only (Vol.5 expands this)
  researchLevels: Record<string, number>;
  allianceId: string | null;
  displayName: string;
  power: number;                // cached/derived, recalculated on write (§7.2)
}

export interface BuildingConfigRow {
  building_id: string;
  display_name: string;
  max_level: number;
  category: string;
  unlock_castle_level: number;
  resource_type: 'gold' | 'crystal' | 'mithril' | null; // Volume 2 §2.3
  effect_type: 'production' | 'storage_cap' | 'troop_capacity' | 'defense_stat' | 'utility'; // Volume 2 §2.3
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
  secondary_stat_value: number | null; // Volume 2 §3.3: Hospital's heal_rate_per_hour only
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
