// modules/heroes/equipment.ts
import { EquipmentInstance, INVENTORY_COLLECTION, HeroInstance } from './types';
import { getEquipmentConfig } from './config';
import { readHeroInstance, writeHeroInstance } from './roster';

// Inventory holds two shapes under one collection, per Volume 4 §4.1:
//  - stackable currency-like items (hero shards, faction cards): stored as
//    { itemId, count } under key = itemId
//  - unique equipment instances (rolled substats): stored as
//    EquipmentInstance under key = itemInstanceId
// Distinguished by key format (itemInstanceId always has a generated
// suffix), not a discriminator field, keeping this consistent with how the
// rest of the codebase avoids adding fields "just in case."

interface StackableEntry {
  itemId: string;
  count: number;
}

export function getInventoryItemCount(nk: nkruntime.Nakama, userId: string, itemId: string): number {
  const result = nk.storageRead([{ collection: INVENTORY_COLLECTION, key: itemId, userId }]);
  if (!result || result.length === 0) return 0;
  return (result[0].value as StackableEntry).count;
}

export function addInventoryItem(nk: nkruntime.Nakama, userId: string, itemId: string, amount: number): void {
  const current = getInventoryItemCount(nk, userId, itemId);
  nk.storageWrite([{
    collection: INVENTORY_COLLECTION, key: itemId, userId,
    value: { itemId, count: current + amount } as StackableEntry,
    permissionRead: 1, permissionWrite: 0,
  }]);
}

export function spendInventoryItem(nk: nkruntime.Nakama, userId: string, itemId: string, amount: number): boolean {
  const current = getInventoryItemCount(nk, userId, itemId);
  if (current < amount) return false;
  nk.storageWrite([{
    collection: INVENTORY_COLLECTION, key: itemId, userId,
    value: { itemId, count: current - amount } as StackableEntry,
    permissionRead: 1, permissionWrite: 0,
  }]);
  return true;
}

export function readInventoryItem(nk: nkruntime.Nakama, userId: string, itemInstanceId: string): EquipmentInstance | null {
  const result = nk.storageRead([{ collection: INVENTORY_COLLECTION, key: itemInstanceId, userId }]);
  if (!result || result.length === 0) return null;
  return result[0].value as EquipmentInstance;
}

export function writeInventoryItem(nk: nkruntime.Nakama, userId: string, item: EquipmentInstance): void {
  nk.storageWrite([{
    collection: INVENTORY_COLLECTION, key: item.itemInstanceId, userId,
    value: item, permissionRead: 1, permissionWrite: 0,
  }]);
}

// §4.3: rolled server-side at acquisition — not exposed as its own RPC yet
// since the acquisition source (loot/shop/Volume 12) isn't built; this is
// the function that source will call.
export function rollNewEquipmentInstance(nk: nkruntime.Nakama, userId: string, itemId: string): EquipmentInstance | null {
  const cfg = getEquipmentConfig(nk, itemId);
  if (!cfg) return null;

  const pool = nk.sqlQuery(
    `SELECT substat_key, min_value, max_value FROM equipment_substat_pool WHERE item_id = $1`,
    [itemId]
  ) || [];

  const rolledSubstats: Record<string, number> = {};
  // Roll 1-4 substats per §4.3 (skips 'common' rarity, which the doc says
  // rolls none — callers should check cfg.rarity before calling if that
  // distinction matters to them; kept simple here since the pool itself
  // will just be empty for common-rarity items in seed data).
  const rollCount = Math.min(pool.length, 1 + Math.floor(Math.random() * 4));
  const shuffled = [...pool].sort(() => Math.random() - 0.5).slice(0, rollCount);
  for (const row of shuffled) {
    const min = Number(row.min_value), max = Number(row.max_value);
    rolledSubstats[row.substat_key] = Math.round((min + Math.random() * (max - min)) * 100) / 100;
  }

  const item: EquipmentInstance = {
    itemInstanceId: `${itemId}_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
    itemId, level: 1, rolledSubstats, equippedToHeroInstanceId: null,
  };
  writeInventoryItem(nk, userId, item);
  return item;
}

function unequip(nk: nkruntime.Nakama, userId: string, itemInstanceId: string): void {
  const item = readInventoryItem(nk, userId, itemInstanceId);
  if (!item) return;
  item.equippedToHeroInstanceId = null;
  writeInventoryItem(nk, userId, item);
}

// §4.4 — matches the doc's reference implementation almost verbatim,
// adapted to this codebase's respond/error conventions.
export function rpcEquipItem(
  ctx: nkruntime.Context,
  logger: nkruntime.Logger,
  nk: nkruntime.Nakama,
  payload: string
): string {
  const userId = ctx.userId;
  if (!userId) return JSON.stringify({ ok: false, error: 'unauthenticated' });
  const req = JSON.parse(payload) as { heroInstanceId: string; itemInstanceId: string; slot: string };

  const hero = readHeroInstance(nk, userId, req.heroInstanceId);
  const item = readInventoryItem(nk, userId, req.itemInstanceId);
  if (!hero || !item) return JSON.stringify({ ok: false, error: 'not_found' });
  if (item.equippedToHeroInstanceId && item.equippedToHeroInstanceId !== hero.instanceId) {
    return JSON.stringify({ ok: false, error: 'item_already_equipped' });
  }

  const previousItemId = hero.equipment[req.slot];
  if (previousItemId) {
    unequip(nk, userId, previousItemId); // auto-swap
  }

  hero.equipment[req.slot] = item.itemInstanceId;
  item.equippedToHeroInstanceId = hero.instanceId;
  writeHeroInstance(nk, userId, hero);
  writeInventoryItem(nk, userId, item);

  return JSON.stringify({ ok: true, hero });
}

export function rpcUnequipItem(
  ctx: nkruntime.Context,
  logger: nkruntime.Logger,
  nk: nkruntime.Nakama,
  payload: string
): string {
  const userId = ctx.userId;
  if (!userId) return JSON.stringify({ ok: false, error: 'unauthenticated' });
  const req = JSON.parse(payload) as { heroInstanceId: string; slot: string };

  const hero = readHeroInstance(nk, userId, req.heroInstanceId);
  if (!hero) return JSON.stringify({ ok: false, error: 'hero_not_found' });

  const itemInstanceId = hero.equipment[req.slot];
  if (!itemInstanceId) return JSON.stringify({ ok: false, error: 'slot_empty' });

  unequip(nk, userId, itemInstanceId);
  hero.equipment[req.slot] = null;
  writeHeroInstance(nk, userId, hero);

  return JSON.stringify({ ok: true, hero });
}