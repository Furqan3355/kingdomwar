// modules/util/jsonb.ts
// nk.sqlQuery's handling of Postgres JSONB columns is inconsistent across
// Nakama JS runtime versions/configurations. Observed in Volume 6 testing:
// a JSONB value can come back as either (a) a raw JSON string, or (b) a
// byte-array-shaped plain object like {"0":123,"1":34,"2":97,...} where
// each numeric key holds one UTF-8 byte code of the JSON text (this is
// what a Buffer/Uint8Array looks like once it round-trips through
// JSON — Buffer's own JSON representation is {0:byte,1:byte,...}).
// Neither case is "already the object we asked for," so every JSONB read
// in this codebase should go through this helper rather than trusting the
// value as-is. (Root cause note: `typeof value === 'string'` alone does
// NOT catch case (b), since typeof a byte-array-shaped object is
// 'object' — this cost real debugging time before the byte-array shape
// was identified from the character-code pattern in a garbled RPC
// response.)

function looksLikeByteArray(obj: Record<string, unknown>): boolean {
  const keys = Object.keys(obj);
  if (keys.length === 0) return false;
  // A genuine byte-array-from-Buffer has consecutive numeric string keys
  // "0","1","2",... . Real troop/garrison objects use unit-id keys like
  // "knight"/"archer"/"npcTroops" and would never match this shape.
  for (let i = 0; i < keys.length; i++) {
    if (keys[i] !== String(i)) return false;
    if (typeof obj[keys[i]] !== 'number') return false;
  }
  return true;
}

export function decodeJsonbField<T>(value: unknown): T {
  if (value === null || value === undefined) return value as T;
  if (typeof value === 'string') {
    return JSON.parse(value) as T;
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if (looksLikeByteArray(obj)) {
      const bytes = Object.keys(obj)
        .map((k) => Number(k))
        .sort((a, b) => a - b)
        .map((i) => obj[String(i)] as number);
      const text = String.fromCharCode(...bytes);
      return JSON.parse(text) as T;
    }
  }
  // Already a proper parsed object (or genuinely null/primitive) — use as-is.
  return value as T;
}