import { buildCsv } from "./export";
import type {
  Concept,
  ConceptExcerpt,
  ConceptTag,
  RecordRow,
  SearchGroup,
} from "./types";

/**
 * Helpers for the Webster and Watson concept matrix. Pure functions,
 * unit tested outside the app.
 */

/**
 * Clean a passage pasted from a PDF viewer: rejoin words hyphenated
 * across line breaks, turn remaining line breaks into spaces, collapse
 * runs of whitespace.
 */
export function cleanQuote(raw: string): string {
  return raw
    .replace(/-\s*\r?\n\s*/g, "")
    .replace(/\s*\r?\n\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Starting concept labels from the Discovery search's concept groups
 * (NOT groups excluded). These are proto concepts only; the real set
 * emerges and is revised while reading.
 */
export function seedLabels(groups: SearchGroup[]): string[] {
  const out: string[] = [];
  for (const g of groups) {
    if (g.not) continue;
    const terms = (g.terms ?? []).map((t) => t.trim()).filter(Boolean);
    if (terms.length === 0) continue;
    const label = terms.slice(0, 3).join(" / ");
    out.push(label.length > 60 ? `${label.slice(0, 57)}...` : label);
  }
  return out;
}

/**
 * The concept matrix as CSV: papers as rows, concepts as columns.
 * A cell holds the unit of analysis when one was recorded, otherwise
 * an x for plain membership.
 */
export function buildMatrixCsv(
  records: RecordRow[],
  concepts: Concept[],
  tags: ConceptTag[]
): string {
  const byKey = new Map<string, ConceptTag>();
  for (const t of tags) byKey.set(`${t.record_id}:${t.concept_id}`, t);
  const header = [
    "Title",
    "Authors",
    "Year",
    ...concepts.map((c) => c.label),
  ];
  const rows = records.map((r) => [
    r.title,
    r.authors,
    r.year,
    ...concepts.map((c) => {
      const t = byKey.get(`${r.id}:${c.id}`);
      if (!t) return "";
      return t.unit?.trim() ? t.unit.trim() : "x";
    }),
  ]);
  return buildCsv(header, rows);
}

/** All evidence passages as CSV, for the writing phase. */
export function buildExcerptsCsv(
  records: RecordRow[],
  concepts: Concept[],
  excerpts: ConceptExcerpt[]
): string {
  const recById = new Map(records.map((r) => [r.id, r]));
  const conById = new Map(concepts.map((c) => [c.id, c]));
  const rows = excerpts
    .filter((e) => recById.has(e.record_id) && conById.has(e.concept_id))
    .map((e) => {
      const r = recById.get(e.record_id)!;
      return [
        conById.get(e.concept_id)!.label,
        r.title,
        r.authors,
        r.year,
        e.page,
        e.quote,
      ];
    })
    .sort((a, b) =>
      String(a[0]).localeCompare(String(b[0])) ||
      String(a[1]).localeCompare(String(b[1]))
    );
  return buildCsv(["Concept", "Title", "Authors", "Year", "Page", "Quote"], rows);
}
