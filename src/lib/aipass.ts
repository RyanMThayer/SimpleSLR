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
    // "matched" (an exact existing label, or "new") wins over "label"
    // when present, so models that answer the match question directly
    // land on the vocabulary concept.
    const matched = typeof o.matched === "string" ? o.matched.trim() : "";
    let label = typeof o.label === "string" ? o.label.trim().slice(0, 120) : "";
    if (matched && matched.toLowerCase() !== "new") {
      label = matched.slice(0, 120);
    }
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

/**
 * New concept labels must be short names, but models sometimes stuff
 * "Label: a whole defining sentence" into the label field. Salvage by
 * splitting at the first ": " or spaced dash (the tail becomes the
 * definition when none was given), then enforce name shape: at most 6
 * words and 60 characters. Returns null when nothing name-shaped can
 * be recovered; the caller drops the concept rather than storing a
 * mangled label. Hyphens inside words (e-government) never split.
 */
export function normalizeNewConceptLabel(
  rawLabel: string,
  definition?: string
): { label: string; definition?: string } | null {
  let label = rawLabel.trim();
  let def = definition;
  const m = /^(.{2,80}?)(?::\s*| [-–—] )(.{8,})$/.exec(label);
  if (m) {
    label = m[1].trim();
    if (!def) def = m[2].trim().slice(0, 500);
  }
  const words = label.split(/\s+/).filter(Boolean);
  if (!label || label.length > 60 || words.length > 6) return null;
  return { label, definition: def };
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

/**
 * The vocabulary block exactly as the AI pass sends it. Shared with
 * the client so the cost preview can measure the true prompt overhead
 * instead of guessing it.
 */
export function vocabBlock(
  concepts: { label: string; description?: string | null }[]
): string {
  return concepts.length > 0
    ? concepts
        .map((c) => `- ${c.label}${c.description ? `: ${c.description}` : ""}`)
        .join("\n")
    : "(none yet - propose the concepts this paper evidences)";
}

/**
 * The system prompt for the AI pass. Lives here rather than in the
 * route so the client's cost preview measures the exact instruction
 * text that will be sent; there is one source of truth.
 */
export function systemPrompt(
  rq: string | null,
  criteria: string | null
): string {
  return [
    "You assist a Webster and Watson style literature review.",
    "Work from this ONE paper alone. Your job: find where it evidences existing vocabulary concepts, and propose new concepts only when nothing in the vocabulary fits even loosely.",
    "",
    `Research question of the review: ${rq?.trim() || "(not recorded)"}`,
    `Inclusion criteria: ${criteria?.trim() || "(not recorded)"}`,
    "",
    "What makes a good concept:",
    "- A broad, reusable theme, mechanism, method family, or outcome, named in 1 to 4 words. It must pass this test: a DIFFERENT paper in this review could plausibly also evidence it. If it cannot, broaden the concept or drop it. Aim the granularity at the level of the research question above.",
    "- Keep specificity in the quotes, not in the concept name; several specific quotes gathered under one broad concept is acceptable and encouraged.",
    "",
    "What counts as evidence (the standard is logical, not lexical):",
    "- A quote evidences a concept only when the passage, read in its surrounding context, shows this paper genuinely engages with the concept. Sharing a word or phrase with the concept's name is NOT evidence by itself.",
    "- Words carry multiple senses. Confirm that the sense used in the passage matches the concept's meaning before using it.",
    "- When a concept implies the paper DID something (a method, an analysis, a design), the passage must show this paper doing it. Passages that mention it about OTHER work (related work, citations), as future work, as a limitation, or in negation are not evidence.",
    "- Before returning, re-read each candidate quote in its surrounding context and drop any whose connection to the concept is lexical rather than logical.",
    "",
    "Budget: at most 8 concepts for this paper. If you find more themes, group them under broader concepts until they fit the budget.",
    "",
    'Return STRICT JSON only, no prose: {"concepts":[{"matched":"...","label":"...","definition":"...","quotes":[{"page":1,"quote":"...","note":"..."}]}]}',
    "Rules:",
    '- "matched": the EXACT label of the existing vocabulary concept this evidence belongs to, or "new" only when none fits. Prefer matching.',
    '- "label": the concept name (the existing label verbatim when matched; your new 1 to 4 word name otherwise).',
    '- "definition": one sentence, new concepts only.',
    "- quotes: 1 to 5 passages per concept, each copied verbatim, character for character, from the page it cites (the paper text is labeled [Page N]). Never paraphrase, never merge distant sentences, never invent text. A quote is roughly one to three sentences.",
    '- "note" on a quote is REQUIRED: one sentence explaining why the passage, in context, evidences the concept. If the honest explanation is only that the wording overlaps, discard the quote instead.',
  ].join("\n");
}
