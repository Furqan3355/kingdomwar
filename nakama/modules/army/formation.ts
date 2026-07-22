// modules/army/formation.ts
import { UnitConfigRow } from '../types';
import { getUnitConfig } from '../config/loader';
import { RenderGroup } from './types';

export function computeSlotsUsed(nk: nkruntime.Nakama, troops: Record<string, number>): number {
  let total = 0;
  for (const unitId in troops) {
    const count = troops[unitId];
    if (!count) continue;
    const cfg = getUnitConfig(nk, unitId);
    const slotCost = cfg ? cfg.slot_cost : 1;
    total += count * slotCost;
  }
  return total;
}

export function computeRenderGroups(troops: Record<string, number>, unitSize: number): RenderGroup[] {
  const size = Math.max(1, unitSize);
  const groups: RenderGroup[] = [];
  for (const unitId in troops) {
    let remaining = troops[unitId];
    if (!remaining || remaining <= 0) continue;
    while (remaining > 0) {
      const troopCount = Math.min(size, remaining);
      groups.push({ unitId, troopCount, attackShare: troopCount / size });
      remaining -= troopCount;
    }
  }
  return groups;
}

export function getUnitConfigOrThrow(nk: nkruntime.Nakama, unitId: string): UnitConfigRow {
  const cfg = getUnitConfig(nk, unitId);
  if (!cfg) throw Error(`unknown unit_id '${unitId}' — check unit_config (0008_army_system.sql)`);
  return cfg;
}