// modules/combat/types.ts
// Volume 6. See volumedocumentation/vol6.md (corrected 2026-07-23) for the
// confirmed mechanics this implements.

export type BattleMode = 'city_attack' | 'skeleton_village' | 'resource_tile' | 'structure';

// Stored in world_tile.occupant_data (0006_world_map.sql's generic JSON
// column) for tile_type IN ('fortress', 'temple', 'neutral_monster',
// 'resource_node'). Deliberately NOT a new table — occupant_data already
// exists exactly for per-tile-type payloads like this, per Volume 3's
// original design intent.
export interface TileGarrison {
  // Fixed NPC defenders. Present (non-empty) for 'fortress'/'temple'/
  // 'neutral_monster' until the first time that garrison is fully wiped —
  // after that this is permanently empty ({}), matching the confirmed
  // "NPC army doesn't respawn once defeated" behavior (same rule applied
  // uniformly to Fortress and Skeleton Village; flagged in vol6.md as an
  // assumption pending confirmation).
  npcTroops: Record<string, number>;
  // A player's army currently stationed on this tile (post-win, per §3.3/
  // §4). Combines WITH npcTroops as one defending force for the next
  // attacker — confirmed Fortress rule: a lone winner's army does not
  // replace the garrison, both fight together.
  stationedUserId: string | null;
  stationedTroops: Record<string, number>;
  // Resource Tile only: resources the stationedUserId has gathered so far
  // at this tile. Transfers to an attacker who fully wipes stationedTroops
  // (§Resource Tile full-wipe rule). Unused (undefined) for other tile types.
  gatheredResources?: Record<string, number>;
}

export function emptyGarrison(): TileGarrison {
  return { npcTroops: {}, stationedUserId: null, stationedTroops: {} };
}

// Result of resolving one battle's troop math — mode-agnostic. Callers
// (city_attack.ts / structure.ts) decide what happens to the tile/army
// afterward; this is pure combat resolution.
export interface BattleResult {
  winner: 'attacker' | 'defender';
  attackerLosses: Record<string, number>;
  defenderLosses: Record<string, number>;
  attackerSurvivors: Record<string, number>;
  defenderSurvivors: Record<string, number>;
  defenderFullyWiped: boolean; // true iff every defender unit count hit zero — gates the Resource Tile loot rule
}

export interface BattleReportRow {
  reportId: number;
  shardId: number;
  tileX: number;
  tileY: number;
  tileType: string;
  mode: BattleMode;
  attackerUserId: string;
  defenderUserId: string | null;
  attackerTroopsBefore: Record<string, number>;
  defenderTroopsBefore: Record<string, number>;
  attackerLosses: Record<string, number>;
  defenderLosses: Record<string, number>;
  attackerSurvivors: Record<string, number>;
  defenderSurvivors: Record<string, number>;
  winner: 'attacker' | 'defender';
  loot: Record<string, number> | null;
  resolvedTick: number;
}