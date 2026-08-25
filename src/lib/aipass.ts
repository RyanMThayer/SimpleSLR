/**
 * Pure helpers for the AI concept pass: parsing the model's JSON and
 * verifying that every suggested quote is a real substring of the
 * paper. Kept free of I/O so they can be unit tested.
 *
 * The integrity rule: a suggestion only survives if its quote can be
 * located verbatim (or with whitespace-run tolerance) in the extracted
 * text of the page the model cited. The model can propose; it cannot
 * fabricate evidence.
 */

export type SuggestedQuote = { page: number; quote: string; note?: string };
export type SuggestedConcept = {
  label: string;
  definition?: string;
  quotes: SuggestedQuote[];
};

const MAX_CONCEPTS = 25;
const MAX_QUOTES = 8;
const MAX_QUOTE_LEN = 2000;

/**
 * Parse the model's output into suggestions. Accepts a bare array or
 * {"concepts": [...]}, tolerating prose around the JSON by extracting
 * the outermost JSON block. Returns null when nothing parseable.
 */
export function parseModelJson(raw: string): SuggestedConcept[] | null {
  const tryParse = (s: string): unknown => {
    try {
      return JSON.parse(s);
    } catch {
      return undefined;
    }
  };
  const toList = (parsed: unknown): unknown[] | null => {
    if (Array.isArray(parsed)) return parsed;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      Array.isArray((parsed as { concepts?: unknown }).concepts)
    ) {
      return (parsed as { concepts: unknown[] }).concepts;
    }
    return null;
  };
  // Whole response first, then the outermost {...} block (the wrapper
  // form), then the outermost [...] block (bare array around prose).
  let list: unknown[] | null = toList(tryParse(raw.trim()));
  if (!list) {
    for (const [open, close] of [
      ["{", "}"],
      ["[", "]"],
    ] as const) {
      const a = raw.indexOf(open);
      const b = raw.lastIndexOf(close);
      if (a !== -1 && b > a) {
        list = toList(tryParse(raw.slice(a, b + 1)));
        if (list) break;
      }
    }
  }
  if (!list) return null;

  const out: SuggestedConcept[] = [];
  for (const item of list.slice(0, MAX_CONCEPTS)) {
    if (typeof item !== "object" || item === null) continue;
    const o = item as Record<string, unknown>;
    const label = typeof o.label === "string" ? o.label.trim().slice(0, 120) : "";
    if (!label) continue;
    const definition =
      typeof o.definition === "string"
        ? o.definition.trim().slice(0, 500)
        : undefined;
    const quotesRaw = Array.isArray(o.quotes) ? o.quotes : [];
    const quotes: SuggestedQuote[] = [];
    for (const q of quotesRaw.slice(0, MAX_QUOTES)) {
      if (typeof q !== "object" || q === null) continue;
      const qo = q as Record<string, unknown>;
      const page =
        typeof qo.page === "number" && Number.isFinite(qo.page)
          ? Math.floor(qo.page)
          : NaN;
      const quote = typeof qo.quote === "string" ? qo.quote.trim() : "";
      if (!quote || quote.length > MAX_QUOTE_LEN || !(page >= 1)) continue;
      quotes.push({
        page,
        quote,
        note:
          typeof qo.note === "string" ? qo.note.trim().slice(0, 500) : undefined,
      });
    }
    if (quotes.length > 0) out.push({ label, definition, quotes });
  }
  return out;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Locate a quote in a page's text. Exact match first; then a
 * whitespace-tolerant match (any whitespace run in the quote matches
 * any whitespace run, or none, in the text — PDF extraction often
 * drops or doubles spaces at line breaks). Returns raw-text offsets.
 */
export function verifyQuote(
  pageText: string,
  quote: string
): { start: number; end: number } | null {
  const exact = pageText.indexOf(quote);
  if (exact !== -1) return { start: exact, end: exact + quote.length };
  const tokens = quote.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;
  const pattern = tokens.map(escapeRegExp).join("\\s*");
  try {
    const m = new RegExp(pattern).exec(pageText);
    if (!m) return null;
    return { start: m.index, end: m.index + m[0].length };
  } catch {
    return null;
  }
}

/** Normalized form used to deduplicate quotes across runs and sources. */
export function normQuote(q: string): string {
  return q.toLowerCase().replace(/\s+/g, " ").trim();
}
