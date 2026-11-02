/** Shared literal search rules for both the MySQL query and local preview data. */
export function searchTokens(value: string) {
  return value.normalize("NFKC").trim().toLocaleLowerCase("zh-CN").split(/\s+/u).filter(Boolean).slice(0, 12);
}

export function originalFileName(stored: string) {
  const leaf = stored.split(/[\\/]/).pop() || stored;
  return leaf.replace(/_([0-9a-f]{8}|seed\d+)(\.[^.]+)$/i, "$2");
}

export function matchesSearch(query: string, fields: (string | null | undefined)[]) {
  const values = fields.map((value) => (value || "").normalize("NFKC").toLocaleLowerCase("zh-CN"));
  return searchTokens(query).every((token) => values.some((value) => value.includes(token)));
}
