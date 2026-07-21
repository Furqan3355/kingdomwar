// modules/heroes/types.ts
// Volume 4. Per-player hero/equipment instances — Nakama storage
// (per-player-scoped data, unlike Volume 3's world tiles), separate
// collections from KingdomState per Volume 1 §7.3 (different write
// frequency — leveling a hero shouldn't contend with resource-tick writes).

export interface HeroInstance {
  heroId: string;             // references hero_config.hero_id (already faction-specific)
  instanceId: string;
  level: number;
  experience: number;
  ascensionTier: number;
  equipment: Record<string, string | null>; // slot -> item instance id
  skillLevels: Record<string, number>;       // skillId -> level
  assignedTo: 'garrison' | 'march' | null;
}

export interface EquipmentInstance {
  itemInstanceId: string;
  itemId: string;
  level: number;
  rolledSubstats: Record<string, number>;
  equippedToHeroInstanceId: string | null;
}

export const HERO_ROSTER_COLLECTION = 'hero_roster';
export const INVENTORY_COLLECTION = 'inventory';

// User's design: one hero per march (not an array) — enforced by this being
// a single optional field rather than heroInstanceIds[]. If that army is
// wiped in combat resolution (Volume 6), the hero does NOT die with it —
// Volume 6's resolver must return the hero to garrison at its origin city
// instead of removing it. Flagging here since Volume 4 only owns the field
// existing, not the combat-resolution behavior.
export interface MarchHeroAssignment {
  heroInstanceId: string | null;
}

export type FactionId = 'fire' | 'water' | 'earth' | 'air';
export const ALL_FACTIONS: FactionId[] = ['fire', 'water', 'earth', 'air'];

export const FACTION_CARD_ITEM_ID = 'faction_change_card';