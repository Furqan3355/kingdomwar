// modules/heroes/factions.ts
import { ALL_FACTIONS, FactionId, FACTION_CARD_ITEM_ID } from './types';
import { readKingdomState, writeKingdomState } from '../economy/resources';
import { spendInventoryItem } from './equipment';

// Called from auth/hooks.ts at new-player init. Random, not load-balanced
// (unlike shard assignment) — per user's design, faction is just a random
// starting pick, not a population-balancing mechanic.
export function assignRandomFaction(): FactionId {
  return ALL_FACTIONS[Math.floor(Math.random() * ALL_FACTIONS.length)];
}

// Spends one faction_change_card (Volume 4 custom addition — not in the
// original doc's RPC list) to let a player switch factions. Since heroes
// are faction-specific (mirrored roster, §ownsHeroFamily in roster.ts),
// switching faction does NOT retroactively change existing HeroInstances —
// a player keeps whatever faction-specific heroes they already acquired.
// Only NEW acquisitions (rpcAcquireHero) resolve against the new faction
// going forward. This avoids the messy case of a hero's whole skill kit
// silently changing under a player mid-game.
export function rpcChangeFaction(
  ctx: nkruntime.Context,
  logger: nkruntime.Logger,
  nk: nkruntime.Nakama,
  payload: string
): string {
  const userId = ctx.userId;
  if (!userId) return JSON.stringify({ ok: false, error: 'unauthenticated' });
  const req = JSON.parse(payload) as { newFactionId: FactionId };

  if (!ALL_FACTIONS.includes(req.newFactionId)) {
    return JSON.stringify({ ok: false, error: 'invalid_faction' });
  }

  const state = readKingdomState(nk, userId);
  if (!state) return JSON.stringify({ ok: false, error: 'no_kingdom_state' });

  if (state.factionId === req.newFactionId) {
    return JSON.stringify({ ok: false, error: 'already_this_faction' });
  }

  const spent = spendInventoryItem(nk, userId, FACTION_CARD_ITEM_ID, 1);
  if (!spent) {
    return JSON.stringify({ ok: false, error: 'no_faction_change_card' });
  }

  state.factionId = req.newFactionId;
  writeKingdomState(nk, userId, state);
  return JSON.stringify({ ok: true, factionId: state.factionId });
}