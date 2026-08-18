import { normalizeDoi, normalizeTitle } from "./normalize";
import type { RecordRow } from "./types";

/**
 * Match an uploaded PDF to a record, position aware: a paper's own
 * title sits at the top of page 1 and its own DOI is printed on page 1,
 * while titles and DOIs of CITED papers appear later (related work,
 * footnotes, references). So only page 1 evidence identifies the paper,
 * and evidence near the top of page 1 beats evidence lower down.
 */

export type MatchOutcome = {
  record: RecordRow | null;
  /** Short label for the review list ("DOI exact", "title, top of page 1", ...) */
  label: string;
  /** Extra context, e.g. citation lookalikes that were deliberately not matched. */
  note: string;
};

export type PdfText = { page1: string; rest: string };

/** Extract text from the first pages of a PDF, in the browser. */
export async function extractFirstPagesText(
  file: File,
  maxPages = 2
): Promise<PdfText> {
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
    const pageText = async (p: number) => {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      return content.items
        .map((it) => ("str" in it ? (it as { str: string }).str : ""))
        .join(" ");
    };
    const page1 = doc.numPages >= 1 ? await pageText(1) : "";
    let rest = "";
    const n = Math.min(maxPages, doc.numPages);
    for (let p = 2; p <= n; p++) {
      rest += (await pageText(p)) + " ";
    }
    return { page1, rest };
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

/** Chars of normalized page 1 text considered "the top" (title zone). */
const HEAD_LIMIT = 600;

export function matchRecord(
  text: PdfText,
  candidates: RecordRow[]
): MatchOutcome {
  const norm1 = normalizeTitle(text.page1);
  const titleOf = (r: RecordRow) => r.norm_title ?? normalizeTitle(r.title);
  const doiOf = (r: RecordRow) => r.norm_doi ?? normalizeDoi(r.doi);

  // 1. DOIs printed on page 1 (page 2+ DOIs are likely citations).
  const page1Dois = new Set(findDois(text.page1));
  if (page1Dois.size > 0) {
    const doiHits = candidates.filter((r) => {
      const d = doiOf(r);
      return d !== null && page1Dois.has(d);
    });
    if (doiHits.length === 1) {
      return { record: doiHits[0], label: "DOI exact", note: "" };
    }
    if (doiHits.length > 1) {
      // Several candidate DOIs on page 1 (citations in footnotes):
      // prefer the one whose title appears earliest on page 1.
      const ranked = doiHits
        .map((r) => ({ r, idx: norm1.indexOf(titleOf(r)) }))
        .filter((x) => x.idx >= 0)
        .sort((a, b) => a.idx - b.idx);
      if (ranked.length > 0) {
        return {
          record: ranked[0].r,
          label: "DOI + title",
          note: "Several known DOIs appear on page 1; picked the one whose title is highest.",
        };
      }
      return {
        record: null,
        label: "no match",
        note: "Several known DOIs appear on page 1; assign manually.",
      };
    }
  }

  // 2. Titles on page 1, ranked by position.
  const titleHits = candidates
    .map((r) => {
      const t = titleOf(r);
      if (!t || t.length < 15) return null;
      const idx = norm1.indexOf(t);
      return idx >= 0 ? { r, idx } : null;
    })
    .filter((x): x is { r: RecordRow; idx: number } => x !== null)
    .sort((a, b) => a.idx - b.idx);

  const headHits = titleHits.filter((x) => x.idx < HEAD_LIMIT);
  if (headHits.length > 0) {
    const lower = titleHits.filter((x) => x.idx >= HEAD_LIMIT);
    return {
      record: headHits[0].r,
      label: "title, top of page 1",
      note:
        lower.length > 0
          ? `Also found lower on the page (likely citations): ${lower
              .map((x) => x.r.title.slice(0, 50))
              .join("; ")}`
          : "",
    };
  }
  if (titleHits.length === 1) {
    // One known title on page 1, but not at the top: could be the paper
    // (unusual layout) or a citation. Suggest it, flag for a look.
    return {
      record: titleHits[0].r,
      label: "title on page 1 (verify)",
      note: "The title was found below the usual title position; confirm before uploading.",
    };
  }
  if (titleHits.length > 1) {
    return {
      record: null,
      label: "no match",
      note: `Several known titles appear on page 1 but none at the top (likely citations): ${titleHits
        .map((x) => x.r.title.slice(0, 50))
        .join("; ")}. Assign manually.`,
    };
  }

  // 3. Fuzzy fallback: token overlap against the page 1 head zone only.
  // Requires a clear margin over the runner-up, so topically similar
  // titles sharing vocabulary cannot both qualify, and is always
  // labeled for verification: bag-of-words scores are suggestions,
  // never certainty.
  const head = norm1.slice(0, HEAD_LIMIT);
  const scored = candidates
    .map((r) => {
      const t = titleOf(r);
      if (!t || t.length < 15) return null;
      const tokens = t.split(" ").filter((w) => w.length > 3);
      if (tokens.length < 4) return null;
      const hits = tokens.filter((w) => head.includes(w)).length;
      return { r, score: hits / tokens.length };
    })
    .filter((x): x is { r: RecordRow; score: number } => x !== null)
    .sort((a, b) => b.score - a.score);
  const best = scored[0];
  const second = scored[1];
  if (best && best.score >= 0.85 && best.score - (second?.score ?? 0) >= 0.1) {
    return {
      record: best.r,
      label: `title ${(best.score * 100).toFixed(0)}% (verify)`,
      note: "Matched by word overlap in the title zone, not an exact title; confirm before uploading.",
    };
  }

  // 4. Citation lookalikes beyond page 1, purely informational.
  const normRest = normalizeTitle(text.rest);
  const restHits = candidates.filter((r) => {
    const t = titleOf(r);
    return t.length >= 15 && normRest.includes(t);
  });
  return {
    record: null,
    label: "no match",
    note:
      restHits.length > 0
        ? `Titles of known records appear beyond page 1 (likely citations): ${restHits
            .map((r) => r.title.slice(0, 50))
            .join("; ")}. Assign manually.`
        : "",
  };
}
