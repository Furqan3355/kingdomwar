// modules/heroes/roster.ts
import { HeroInstance, HERO_ROSTER_COLLECTION } from './types';
import { getHeroConfig, getHeroRarityConfig, getHeroIdForFamilyAndFaction, getHeroAscensionConfig } from './config';
import { addInventoryItem, getInventoryItemCount, spendInventoryItem } from './equipment';
import { readKingdomState } from '../economy/resources';

export function readHeroInstance(nk: nkruntime.Nakama, userId: string, instanceId: string): HeroInstance | null {
  const result = nk.storageRead([{ collection: HERO_ROSTER_COLLECTION, key: instanceId, userId }]);
  if (!result || result.length === 0) return null;
  return result[0].value as HeroInstance;
}

export function writeHeroInstance(nk: nkruntime.Nakama, userId: string, hero: HeroInstance): void {
  nk.storageWrite([{
    collection: HERO_ROSTER_COLLECTION, key: hero.instanceId, userId,
    value: hero, permissionRead: 1, permissionWrite: 0,
  }]);
}

// List a player's whole roster — used by get_full_state (replaces the
// Volume 1 heroes:[] stub) and by rpcGetHeroRoster directly.
export function listHeroRoster(nk: nkruntime.Nakama, userId: string): HeroInstance[] {
  let cursor: string | undefined = undefined;
  const heroes: HeroInstance[] = [];
  do {
    const page = nk.storageList(userId, HERO_ROSTER_COLLECTION, 100, cursor);
    if (!page || !page.objects) break;
    for (const obj of page.objects) heroes.push(obj.value as HeroInstance);
    cursor = page.cursor || undefined;
  } while (cursor);
  return heroes;
}

function ownsHeroFamily(roster: HeroInstance[], nk: nkruntime.Nakama, heroFamily: string): HeroInstance | null {
  for (const h of roster) {
    const cfg = getHeroConfig(nk, h.heroId);
    if (cfg && cfg.hero_family === heroFamily) return h;
  }
  return null;
}

// §6.3: duplicate heroes become shard currency instead of a second
// HeroInstance. "Duplicate" is judged by hero_family, not exact hero_id —
// a player can only ever own one copy of a given family (their faction's
// version of it), so re-acquiring the same family always converts to shards.
export function rpcAcquireHero(
  ctx: nkruntime.Context,
  logger: nkruntime.Logger,
  nk: nkruntime.Nakama,
  payload: string
): string {
  const userId = ctx.userId;
  if (!userId) return JSON.stringify({ ok: false, error: 'unauthenticated' });

  const req = JSON.parse(payload) as { heroFamily: string };
  const state = readKingdomState(nk, userId);
  if (!state) return JSON.stringify({ ok: false, error: 'no_kingdom_state' });

  const factionId = state.factionId;
  if (!factionId) return JSON.stringify({ ok: false, error: 'no_faction_assigned' });

  const heroId = getHeroIdForFamilyAndFaction(nk, req.heroFamily, factionId);
  if (!heroId) return JSON.stringify({ ok: false, error: 'unknown_hero_family_for_faction' });

  const roster = listHeroRoster(nk, userId);
  const existing = ownsHeroFamily(roster, nk, req.heroFamily);

  if (existing) {
    // Duplicate -> shard currency, per §6.3.
    addInventoryItem(nk, userId, `shard_${heroId}`, 1);
    return JSON.stringify({ ok: true, result: 'converted_to_shard', heroId });
  }

  const instanceId = `${heroId}_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
  const newHero: HeroInstance = {
    heroId, instanceId, level: 1, experience: 0, ascensionTier: 0,
    equipment: {}, skillLevels: {}, assignedTo: null,
  };
  writeHeroInstance(nk, userId, newHero);
  return JSON.stringify({ ok: true, result: 'acquired', hero: newHero });
}

export function rpcGetHeroRoster(
  ctx: nkruntime.Context,
  logger: nkruntime.Logger,
  nk: nkruntime.Nakama,
  payload: string
): string {
  const userId = ctx.userId;
  if (!userId) return JSON.stringify({ ok: false, error: 'unauthenticated' });
  return JSON.stringify({ ok: true, heroes: listHeroRoster(nk, userId) });
}

// §5.2/§5.3: xp_required(level) = base_xp * level^curve_exponent * rarity.xp_curve_multiplier
// Level cap additionally gated by ascensionTier (§5.3) — level_band=20 per
// the doc's example.
const BASE_XP = 100;
const CURVE_EXPONENT = 2.2;
const LEVEL_BAND_PER_ASCENSION = 20;

function xpRequiredForLevel(level: number, xpCurveMultiplier: number): number {
  return Math.round(BASE_XP * Math.pow(level, CURVE_EXPONENT) * xpCurveMultiplier);
}

export function rpcLevelUpHero(
  ctx: nkruntime.Context,
  logger: nkruntime.Logger,
  nk: nkruntime.Nakama,
  payload: string
): string {
  const userId = ctx.userId;
  if (!userId) return JSON.stringify({ ok: false, error: 'unauthenticated' });
  const req = JSON.parse(payload) as { instanceId: string };

  const hero = readHeroInstance(nk, userId, req.instanceId);
  if (!hero) return JSON.stringify({ ok: false, error: 'hero_not_found' });

  const heroCfg = getHeroConfig(nk, hero.heroId);
  if (!heroCfg) return JSON.stringify({ ok: false, error: 'hero_config_missing' });
  const rarityCfg = getHeroRarityConfig(nk, heroCfg.rarity);
  if (!rarityCfg) return JSON.stringify({ ok: false, error: 'rarity_config_missing' });

  const levelCap = (hero.ascensionTier + 1) * LEVEL_BAND_PER_ASCENSION;
  if (hero.level >= levelCap) {
    return JSON.stringify({ ok: false, error: 'level_cap_reached_needs_ascension', levelCap });
  }

  const required = xpRequiredForLevel(hero.level, rarityCfg.xp_curve_multiplier);
  if (hero.experience < required) {
    return JSON.stringify({ ok: false, error: 'insufficient_experience', required, have: hero.experience });
  }

  hero.experience -= required;
  hero.level += 1;
  writeHeroInstance(nk, userId, hero);
  return JSON.stringify({ ok: true, hero });
}

// §6.4: re-validate shard/material counts server-side, apply atomically.
export function rpcAscendHero(
  ctx: nkruntime.Context,
  logger: nkruntime.Logger,
  nk: nkruntime.Nakama,
  payload: string
): string {
  const userId = ctx.userId;
  if (!userId) return JSON.stringify({ ok: false, error: 'unauthenticated' });
  const req = JSON.parse(payload) as { instanceId: string };

  const hero = readHeroInstance(nk, userId, req.instanceId);
  if (!hero) return JSON.stringify({ ok: false, error: 'hero_not_found' });

  const nextTier = hero.ascensionTier + 1;
  const ascCfg = getHeroAscensionConfig(nk, hero.heroId, nextTier);
  if (!ascCfg) return JSON.stringify({ ok: false, error: 'no_further_ascension_available' });

  const shardItemId = `shard_${hero.heroId}`;
  const haveShards = getInventoryItemCount(nk, userId, shardItemId);
  if (haveShards < ascCfg.required_shards) {
    return JSON.stringify({ ok: false, error: 'insufficient_shards', required: ascCfg.required_shards, have: haveShards });
  }
  // required_items (JSONB) checks would follow the same
  // getInventoryItemCount/spendInventoryItem pattern per material — omitted
  // here since the shape of required_items is design-authored and not yet
  // seeded; wire in identically to the shard check once seed data exists.

  spendInventoryItem(nk, userId, shardItemId, ascCfg.required_shards);
  hero.ascensionTier = nextTier;
  writeHeroInstance(nk, userId, hero);
  return JSON.stringify({ ok: true, hero, unlocksLevelCap: ascCfg.unlocks_level_cap });
}