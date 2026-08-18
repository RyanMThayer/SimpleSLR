/** Normalization helpers used for deduplication. */

export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // strip diacritics
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeDoi(doi: string | null): string | null {
  if (!doi) return null;
  let d = doi.trim().toLowerCase();
  d = d.replace(/^https?:\/\/(dx\.)?doi\.org\//, "");
  d = d.replace(/^doi:\s*/, "");
  return d || null;
}

/**
 * Extract comparable author name tokens (mostly surnames) from an
 * authors string in any common format ("Müller, Anna; Smith, J." or
 * "A. Mueller and John Smith"). Single letters (initials) are dropped.
 */
export function authorTokens(authors: string | null): Set<string> {
  if (!authors) return new Set();
  const tokens = authors
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\band\b/g, " ")
    .replace(/[^a-z ]+/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 2);
  return new Set(tokens);
}

/** True when two author token sets share at least one name token. */
export function sharesAuthor(a: Set<string>, b: Set<string>): boolean {
  for (const t of a) {
    if (b.has(t)) return true;
  }
  return false;
}
