// modules/worldmap/types.ts
// Volume 3 §1. Coordinate/tile model. Kept separate from the per-player
// KingdomState types.ts — this data is shard-global, not per-player.

export interface TileCoord {
  x: number; // 0..1023
  y: number; // 0..1023
}

export const WORLD_GRID_SIZE = 1024;
export const REGION_SIZE = 32; // §1.3 — query-performance chunking, not gameplay
export const MAX_VIEWPORT_TILES = 2500; // hard cap per get_world_view call (50x50)

export function tileKey(coord: TileCoord): string {
  return `${coord.x}_${coord.y}`;
}

export function regionOf(coord: TileCoord): { rx: number; ry: number } {
  return { rx: Math.floor(coord.x / REGION_SIZE), ry: Math.floor(coord.y / REGION_SIZE) };
}

// Chebyshev distance — §1.2. Diagonal movement is not "cheaper" than
// orthogonal, matching 8-directional grid intuition and removing the
// diagonal-march exploit Euclidean distance would allow.
export function chebyshevDistance(a: TileCoord, b: TileCoord): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

export function isInBounds(coord: TileCoord): boolean {
  return coord.x >= 0 && coord.x < WORLD_GRID_SIZE && coord.y >= 0 && coord.y < WORLD_GRID_SIZE;
}

export type TileType =
  | 'empty'
  | 'resource_node'
  | 'player_castle'
  | 'neutral_monster'
  | 'boss_monster'
  | 'alliance_territory';

export interface WorldTile {
  shardId: number;
  x: number;
  y: number;
  tileType: TileType;
  ownerUserId: string | null;
  ownerAllianceId: string | null;
  occupantData: unknown;
  lastUpdatedTick: number;
  version: number;
}

export type MarchType = 'attack' | 'gather' | 'reinforce' | 'scout';
export type MarchStatus = 'marching' | 'arrived' | 'returning' | 'completed' | 'recalled';

export interface ArmyMarch {
  marchId: string;
  shardId: number;
  userId: string;
  marchType: MarchType;
  origin: TileCoord;
  target: TileCoord;
  troops: Record<string, number>;
  departureTick: number;
  arrivalTick: number;
  status: MarchStatus;
  resolved: boolean;
}

// Design constant: how many marches the sweep resolves per invocation.
// The external cron (Volume 3 §11 "external scheduler") should call
// sweep_march_arrivals every 5-10s; at batch 500 that comfortably clears
// 10k simultaneous arrivals within a few sweep cycles without ever holding
// a long-running transaction or scanning unresolved rows beyond this page.
export const MARCH_SWEEP_BATCH_SIZE = 500;