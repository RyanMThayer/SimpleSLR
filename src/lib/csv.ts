import type { ParsedRef } from "./types";

/**
 * Small RFC 4180 style CSV parser (quotes, embedded commas and newlines).
 * Returns rows as string arrays.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  // Strip BOM.
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((f) => f.trim() !== "")) rows.push(row);
      row = [];
    } else {
      field += c;
    }
  }
  row.push(field);
  if (row.some((f) => f.trim() !== "")) rows.push(row);
  return rows;
}

export type ColumnMapping = {
  title: number | null;
  authors: number | null;
  year: number | null;
  venue: number | null;
  abstract: number | null;
  doi: number | null;
  url: number | null;
};

const HEADER_GUESSES: Record<keyof ColumnMapping, string[]> = {
  title: ["title", "document title", "article title", "ti"],
  authors: ["authors", "author", "author full names", "au", "creator"],
  year: ["year", "publication year", "py", "date", "publication_year"],
  venue: [
    "source title",
    "journal",
    "publication title",
    "venue",
    "source",
    "so",
    "booktitle",
  ],
  abstract: ["abstract", "ab", "description"],
  doi: ["doi", "di", "digital object identifier"],
  url: ["url", "link", "ur", "document link"],
};

/** Guess which CSV column holds which field, from the header row. */
export function guessMapping(header: string[]): ColumnMapping {
  const mapping: ColumnMapping = {
    title: null,
    authors: null,
    year: null,
    venue: null,
    abstract: null,
    doi: null,
    url: null,
  };
  const normalized = header.map((h) => h.trim().toLowerCase());
  (Object.keys(HEADER_GUESSES) as (keyof ColumnMapping)[]).forEach((key) => {
    for (const guess of HEADER_GUESSES[key]) {
      const idx = normalized.indexOf(guess);
      if (idx !== -1) {
        mapping[key] = idx;
        return;
      }
    }
    // fall back to "contains" matching, only for unambiguous longer names
    for (const guess of HEADER_GUESSES[key]) {
      if (guess.length < 4) continue;
      const idx = normalized.findIndex((h) => h.includes(guess));
      if (idx !== -1) {
        mapping[key] = idx;
        return;
      }
    }
  });
  return mapping;
}

export function rowsToRefs(
  rows: string[][],
  mapping: ColumnMapping
): ParsedRef[] {
  const refs: ParsedRef[] = [];
  for (const row of rows) {
    const pick = (idx: number | null): string | null => {
      if (idx === null || idx >= row.length) return null;
      const v = row[idx].trim();
      return v || null;
    };
    const title = pick(mapping.title);
    if (!title) continue;
    const yearRaw = pick(mapping.year);
    const yearMatch = yearRaw?.match(/\d{4}/);
    refs.push({
      title,
      authors: pick(mapping.authors),
      year: yearMatch ? parseInt(yearMatch[0], 10) : null,
      venue: pick(mapping.venue),
      abstract: pick(mapping.abstract),
      doi: pick(mapping.doi),
      url: pick(mapping.url),
    });
  }
  return refs;
}
