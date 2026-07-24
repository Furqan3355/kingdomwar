// modules/combat/resolver.ts
// Volume 6. Pure combat math — no storage/tile/RPC concerns here, so this
// is trivially unit-testable and shared by every mode (City Attack,
// Skeleton Village, Resource Tile, Fortress/Temple).
//
// MVP formula, flagged for balance review (same "MVP now, refine later"
// posture as army/formation.ts's slot math): no archetype rock-paper-
// scissors triangle exists in this project's Volume 5 redesign (fixed
// melee/range/elite roster, no counter table), so this resolver uses a
// straightforward power-ratio model instead of Volume 5's original-doc
// archetype_counter_config, consistent with that redesign.
//
//   attackPower(side)   = sum(count * base_attack)
//   effectiveHP(side)   = sum(count * (base_defense + base_health))
//   lossFraction(side)  = min(1, opponent's attackPower / own effectiveHP)
//   losses are applied proportionally across that side's unit types by
//   count (a mixed army doesn't lose 100% of one unit type before another).
//
// Winner = the side with the higher SURVIVING effectiveHP fraction
// (1 - lossFraction). Tie (both fully wiped, or exactly equal survival) is
// broken in the attacker's favor, matching typical RTS convention that a
// draw at the attacker's initiative counts as a win for the mover.

import { getUnitConfig } from '../config/loader';
import { BattleResult } from './types';

interface SidePower {
  attackPower: number;
  effectiveHP: number;
}

function computeSidePower(nk: nkruntime.Nakama, troops: Record<string, number>): SidePower {
  let attackPower = 0;
  let effectiveHP = 0;
  for (const unitId in troops) {
    const count = troops[unitId];
    if (!count || count <= 0) continue;
    const cfg = getUnitConfig(nk, unitId);
    if (!cfg) continue; // unknown unit_id — skip rather than throw, so a bad NPC seed row can't brick every fight
    attackPower += count * cfg.base_attack;
    effectiveHP += count * (cfg.base_defense + cfg.base_health);
  }
  return { attackPower, effectiveHP };
}

function applyLossFraction(troops: Record<string, number>, lossFraction: number): {
  losses: Record<string, number>;
  survivors: Record<string, number>;
  fullyWiped: boolean;
} {
  const losses: Record<string, number> = {};
  const survivors: Record<string, number> = {};
  let anySurvived = false;
  for (const unitId in troops) {
    const count = troops[unitId] || 0;
    if (count <= 0) {
      losses[unitId] = 0;
      survivors[unitId] = 0;
      continue;
    }
    // Proportional loss, rounded down; the deterministic rounding means
    // exactly lossFraction >= 1 always yields zero survivors of every
    // unit type, which is what defenderFullyWiped relies on below.
    const lost = Math.min(count, Math.round(count * lossFraction));
    losses[unitId] = lost;
    survivors[unitId] = count - lost;
    if (count - lost > 0) anySurvived = true;
  }
  return { losses, survivors, fullyWiped: !anySurvived };
}

export function resolveBattle(
  nk: nkruntime.Nakama,
  attackerTroops: Record<string, number>,
  defenderTroops: Record<string, number>
): BattleResult {
  const atk = computeSidePower(nk, attackerTroops);
  const def = computeSidePower(nk, defenderTroops);

  // Each side's losses are driven by the OPPONENT's attack power against
  // its own effective HP pool.
  const defenderLossFraction = Math.min(1, atk.attackPower / Math.max(1, def.effectiveHP));
  const attackerLossFractionReal = Math.min(1, def.attackPower / Math.max(1, atk.effectiveHP));

  const attackerResult = applyLossFraction(attackerTroops, attackerLossFractionReal);
  const defenderResult = applyLossFraction(defenderTroops, defenderLossFraction);

  const attackerSurvivalShare = atk.effectiveHP > 0 ? 1 - attackerLossFractionReal : 0;
  const defenderSurvivalShare = def.effectiveHP > 0 ? 1 - defenderLossFraction : 0;

  // Tie-break: attacker wins on equal survival share (including the
  // mutual-wipe 0-vs-0 case), per the convention documented above.
  const winner: 'attacker' | 'defender' = attackerSurvivalShare >= defenderSurvivalShare ? 'attacker' : 'defender';

  return {
    winner,
    attackerLosses: attackerResult.losses,
    defenderLosses: defenderResult.losses,
    attackerSurvivors: attackerResult.survivors,
    defenderSurvivors: defenderResult.survivors,
    defenderFullyWiped: defenderResult.fullyWiped,
  };
}

// Merges two troop records (e.g. NPC garrison + stationed player army into
// one combined defending force, per the confirmed Fortress rule).
export function mergeTroops(...sides: Record<string, number>[]): Record<string, number> {
  const merged: Record<string, number> = {};
  for (const side of sides) {
    for (const unitId in side) {
      merged[unitId] = (merged[unitId] || 0) + (side[unitId] || 0);
    }
  }
  return merged;
}

export function isEmptyTroops(troops: Record<string, number>): boolean {
  for (const unitId in troops) {
    if ((troops[unitId] || 0) > 0) return false;
  }
  return true;
}