import type { DocxAsset } from "./office-preview";

type Entry = { at: number; size: number; assets: DocxAsset[] };

const MAX_BYTES = 128 * 1024 * 1024;
const MAX_ENTRIES = 12;
const TTL_MS = 20 * 60 * 1000;
const state = globalThis as typeof globalThis & { __kbDocxAssets?: Map<string, Entry> };
const cache = () => (state.__kbDocxAssets ??= new Map<string, Entry>());

function evict() {
  const entries = cache();
  const now = Date.now();
  for (const [key, entry] of entries) if (now - entry.at > TTL_MS) entries.delete(key);
  let total = [...entries.values()].reduce((sum, entry) => sum + entry.size, 0);
  // Map preserves insertion order, so the oldest entries go first.
  for (const key of [...entries.keys()]) {
    if (entries.size <= MAX_ENTRIES && total <= MAX_BYTES) break;
    total -= entries.get(key)?.size ?? 0;
    entries.delete(key);
  }
}

/** Images extracted from a DOCX, kept briefly so the browser can load them on demand. */
export function putDocxAssets(key: string, assets: DocxAsset[]) {
  const entries = cache();
  entries.delete(key);
  entries.set(key, { at: Date.now(), size: assets.reduce((sum, asset) => sum + asset.bytes.length, 0), assets });
  evict();
}

export function getDocxAssets(key: string) {
  const entry = cache().get(key);
  if (!entry) return null;
  if (Date.now() - entry.at > TTL_MS) { cache().delete(key); return null; }
  // Refresh recency.
  cache().delete(key);
  cache().set(key, { ...entry, at: Date.now() });
  return entry.assets;
}
