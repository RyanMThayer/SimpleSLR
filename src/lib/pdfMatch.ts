import { normalizeDoi, normalizeTitle } from "./normalize";
import type { RecordRow } from "./types";

/**
 * Match an uploaded PDF to a record. Strategy, in order of confidence:
 * 1. A DOI printed in the PDF's first pages that exactly matches a
 *    record's DOI (near certain).
 * 2. The record's normalized title appearing in the extracted text, or
 *    a high token overlap with it (strong).
 * Anything below the threshold is left for manual assignment.
 */

export type PdfMatchResult =
  | { kind: "doi"; record: RecordRow }
  | { kind: "title"; record: RecordRow; score: number }
  | null;

/** Extract text from the first pages of a PDF, in the browser. */
export async function extractFirstPagesText(
  file: File,
  maxPages = 2
): Promise<string> {
  const pdfjs = await import("pdfjs-dist");
  if (!pdfjs.GlobalWorkerOptions.workerSrc) {
    pdfjs.GlobalWorkerOptions.workerSrc = new URL(
      "pdfjs-dist/build/pdf.worker.min.mjs",
      import.meta.url
    ).toString();
  }
  const buf = await file.arrayBuffer();
  const loadingTask = pdfjs.getDocument({ data: buf });
  try {
    const doc = await loadingTask.promise;
    let text = "";
    const n = Math.min(maxPages, doc.numPages);
    for (let p = 1; p <= n; p++) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      text +=
        content.items
          .map((it) => ("str" in it ? (it as { str: string }).str : ""))
          .join(" ") + " ";
    }
    return text;
  } finally {
    await loadingTask.destroy();
  }
}

const DOI_RE = /10\.\d{4,9}\/[^\s"'<>]+/g;

/** Normalized DOIs found in a blob of text. */
export function findDois(text: string): string[] {
  const matches = text.match(DOI_RE) ?? [];
  const out = new Set<string>();
  for (const m of matches) {
    const cleaned = normalizeDoi(m.replace(/[).,;\]]+$/, ""));
    if (cleaned) out.add(cleaned);
  }
  return [...out];
}

/** Match extracted PDF text against candidate records. */
export function matchRecord(
  text: string,
  candidates: RecordRow[]
): PdfMatchResult {
  const dois = new Set(findDois(text));
  if (dois.size > 0) {
    const hit = candidates.find((r) => {
      const d = r.norm_doi ?? normalizeDoi(r.doi);
      return d !== null && dois.has(d);
    });
    if (hit) return { kind: "doi", record: hit };
  }

  const normText = normalizeTitle(text);
  let best: { record: RecordRow; score: number } | null = null;
  for (const r of candidates) {
    const t = r.norm_title ?? normalizeTitle(r.title);
    // Very short titles are unsafe to match on.
    if (!t || t.length < 15) continue;
    let score = 0;
    if (normText.includes(t)) {
      score = 1;
    } else {
      const tokens = t.split(" ").filter((w) => w.length > 3);
      if (tokens.length >= 4) {
        const hits = tokens.filter((w) => normText.includes(w)).length;
        score = hits / tokens.length;
      }
    }
    if (score > (best?.score ?? 0)) best = { record: r, score };
  }
  if (best && best.score >= 0.8) {
    return { kind: "title", record: best.record, score: best.score };
  }
  return null;
}
