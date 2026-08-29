import type { SearchConfig } from "./types";

/**
 * Seed the screening highlight keywords from the project's search
 * strategy. The search builder stores structured concept groups, so
 * this is a faithful mapping, not string parsing: terms from normal
 * groups suggest green (include leaning) highlights, terms from NOT
 * groups suggest red (exclude leaning) ones. Wildcards are trimmed
 * because highlighting matches substrings anyway ("govern" already
 * lights up "government" and "governance").
 */

/** Normalize one search term into a highlightable keyword. */
export function cleanTerm(raw: string): string | null {
  const t = raw
    .trim()
    .replace(/^["']+|["']+$/g, "")
    .replace(/[*?$]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return t.length < 3 ? null : t;
}

export function seedKeywords(
  config: Partial<SearchConfig> | null | undefined
): { include: string[]; exclude: string[] } {
  const include: string[] = [];
  const exclude: string[] = [];
  const seen = new Set<string>();
  for (const g of config?.groups ?? []) {
    for (const raw of g.terms ?? []) {
      const t = cleanTerm(raw);
      if (!t) continue;
      const key = t.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      (g.not ? exclude : include).push(t);
    }
  }
  return { include, exclude };
}

/**
 * Merge suggestions into an existing comma separated field: keeps
 * everything already there (including the user's manual edits) and
 * appends only genuinely new terms.
 */
export function mergeKeywords(existingCsv: string, additions: string[]): string {
  const existing = existingCsv
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const have = new Set(existing.map((s) => s.toLowerCase()));
  const added = additions.filter((a) => {
    const k = a.toLowerCase();
    if (have.has(k)) return false;
    have.add(k);
    return true;
  });
  return [...existing, ...added].join(", ");
}
