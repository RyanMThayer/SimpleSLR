/**
 * Text anchoring for PDF highlights, modeled on the W3C annotation
 * selectors Hypothesis uses: an anchor is the exact quote, character
 * offsets into the page's extracted text, and up to CONTEXT_LEN
 * characters of surrounding context. Re-anchoring tries the stored
 * offsets first, then falls back to searching for the quote and
 * scoring each occurrence by how much of the stored context matches,
 * so highlights survive small extraction differences. Everything here
 * is pure so it can be unit tested without a browser.
 */

export const CONTEXT_LEN = 32;

export type Anchor = {
  quote: string;
  pos_start: number;
  pos_end: number;
  prefix: string;
  suffix: string;
};

/** Build an anchor for the [start, end) slice of one page's text. */
export function buildAnchor(
  pageText: string,
  start: number,
  end: number
): Anchor | null {
  if (
    start < 0 ||
    end > pageText.length ||
    start >= end
  ) {
    return null;
  }
  return {
    quote: pageText.slice(start, end),
    pos_start: start,
    pos_end: end,
    prefix: pageText.slice(Math.max(0, start - CONTEXT_LEN), start),
    suffix: pageText.slice(end, end + CONTEXT_LEN),
  };
}

/** Longest length for which a ends with what b... (shared boundary). */
function suffixOverlap(text: string, at: number, prefix: string): number {
  // How many trailing characters of `prefix` appear immediately before
  // position `at` in `text`.
  let n = 0;
  while (
    n < prefix.length &&
    at - n - 1 >= 0 &&
    text[at - n - 1] === prefix[prefix.length - 1 - n]
  ) {
    n++;
  }
  return n;
}

function prefixOverlap(text: string, at: number, suffix: string): number {
  // How many leading characters of `suffix` appear at position `at`.
  let n = 0;
  while (n < suffix.length && at + n < text.length && text[at + n] === suffix[n]) {
    n++;
  }
  return n;
}

/**
 * Locate an anchor in (possibly changed) page text. Returns the best
 * [start, end) range, or null when the quote no longer appears at all.
 */
export function findAnchor(
  pageText: string,
  anchor: Pick<Anchor, "quote" | "pos_start" | "pos_end" | "prefix" | "suffix">
): { start: number; end: number } | null {
  const { quote } = anchor;
  if (!quote) return null;

  // Fast path: the stored offsets still hold the exact quote.
  if (
    anchor.pos_start >= 0 &&
    anchor.pos_end <= pageText.length &&
    pageText.slice(anchor.pos_start, anchor.pos_end) === quote
  ) {
    return { start: anchor.pos_start, end: anchor.pos_end };
  }

  // Otherwise score every occurrence of the quote by matching context,
  // breaking ties toward the stored position.
  let best: { start: number; score: number; drift: number } | null = null;
  for (
    let at = pageText.indexOf(quote);
    at !== -1;
    at = pageText.indexOf(quote, at + 1)
  ) {
    const score =
      suffixOverlap(pageText, at, anchor.prefix ?? "") +
      prefixOverlap(pageText, at + quote.length, anchor.suffix ?? "");
    const drift = Math.abs(at - anchor.pos_start);
    if (
      best === null ||
      score > best.score ||
      (score === best.score && drift < best.drift)
    ) {
      best = { start: at, score, drift };
    }
  }
  return best ? { start: best.start, end: best.start + quote.length } : null;
}
