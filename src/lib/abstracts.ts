import { normalizeDoi } from "./normalize";
import { oa, reconstructAbstract, resolveWork, type OaWork } from "./openalex";
import type { RecordRow } from "./types";

/**
 * Fill missing abstracts from free scholarly APIs, best source first:
 * OpenAlex (batch by DOI), Semantic Scholar (batch by DOI), Crossref
 * (per DOI), and OpenAlex title matching for records without a DOI.
 */

export type AbstractUpdate = {
  recordId: string;
  abstract: string;
  source: string;
};

/** Strip JATS/XML markup and entities from a Crossref abstract. */
export function jatsToText(raw: string): string {
  return raw
    .replace(/<jats:title[^>]*>[\s\S]*?<\/jats:title>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) =>
      String.fromCodePoint(parseInt(n, 16))
    )
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function tidy(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/**
 * Does this text plausibly read as an abstract? Scholarly indexes
 * (OpenAlex especially) sometimes store junk in the abstract field:
 * author lists, the paper's reference section, or one line publisher
 * notes. Rejecting those beats importing them; a blank abstract can be
 * filled from another source or pasted by hand.
 */
export function plausibleAbstract(raw: string | null | undefined): boolean {
  if (!raw) return false;
  const text = raw.trim();
  if (text.length < 120) return false;
  const words = text.split(/\s+/);
  if (words.length < 25) return false;
  // Reference lists: dense years in parentheses, DOIs, bracket numbers.
  const years = (text.match(/\((?:1[89]|20)\d{2}\)/g) ?? []).length;
  const dois = (text.match(/\bdoi\b|doi\.org/gi) ?? []).length;
  const brackets = (text.match(/\[\d+\]/g) ?? []).length;
  if (years + dois >= 5 || brackets >= 6) return false;
  if (years + dois + brackets >= 3 && (years + dois + brackets) / words.length > 0.02) {
    return false;
  }
  // Author lists: mostly capitalized tokens with dense separators.
  const caps = words.filter((w) => /^[A-Z]/.test(w)).length;
  const seps = (text.match(/[,;]/g) ?? []).length;
  if (caps / words.length > 0.6 && seps >= words.length / 5) return false;
  return true;
}

export type AbstractSearchResult = {
  updates: AbstractUpdate[];
  notes: string[];
};

/** The record fields abstract lookup needs; RecordRow satisfies this. */
export type LookupRecord = Pick<
  RecordRow,
  "id" | "title" | "abstract" | "doi" | "norm_doi" | "norm_title"
>;

/**
 * Find abstracts for every record in `records` whose abstract is
 * missing or fails the plausibility check (junk from an index). Pure
 * lookup: returns proposed updates, does not write to the database.
 */
export async function findMissingAbstracts(
  records: LookupRecord[],
  onProgress: (msg: string) => void
): Promise<AbstractSearchResult> {
  const missing = records.filter((r) => !plausibleAbstract(r.abstract));
  const updates: AbstractUpdate[] = [];
  const notes: string[] = [];
  const found = new Set<string>();

  const byDoi = new Map<string, LookupRecord[]>();
  const noDoi: LookupRecord[] = [];
  for (const r of missing) {
    const d = r.norm_doi ?? normalizeDoi(r.doi);
    // Pipes and commas are OpenAlex filter syntax; such DOIs are rare
    // and go through the title matching fallback instead.
    if (d && !/[|,]/.test(d)) {
      const list = byDoi.get(d) ?? [];
      list.push(r);
      byDoi.set(d, list);
    } else {
      noDoi.push(r);
    }
  }
  const push = (doi: string, text: string, source: string) => {
    for (const r of byDoi.get(doi) ?? []) {
      if (found.has(r.id)) continue;
      found.add(r.id);
      updates.push({ recordId: r.id, abstract: text, source });
    }
  };

  // 1) OpenAlex, batched by DOI.
  const dois = [...byDoi.keys()];
  for (let i = 0; i < dois.length; i += 40) {
    onProgress(
      `OpenAlex: checking DOIs ${Math.min(i + 40, dois.length)}/${dois.length}...`
    );
    const chunk = dois.slice(i, i + 40);
    try {
      const res = await oa<{ results: OaWork[] }>(
        `works?filter=doi:${chunk.join("|")}&per-page=50&select=doi,abstract_inverted_index`
      );
      for (const w of res.results ?? []) {
        const d = normalizeDoi(w.doi);
        if (!d) continue;
        const text = reconstructAbstract(w.abstract_inverted_index);
        if (text && plausibleAbstract(text)) push(d, tidy(text), "OpenAlex");
      }
    } catch {
      notes.push("An OpenAlex batch failed; some DOIs were skipped there.");
    }
  }

  // 2) Semantic Scholar, batched, for what OpenAlex lacked.
  const forS2 = dois.filter((d) =>
    (byDoi.get(d) ?? []).some((r) => !found.has(r.id))
  );
  for (let i = 0; i < forS2.length; i += 400) {
    const chunk = forS2.slice(i, i + 400);
    onProgress(
      `Semantic Scholar: checking DOIs ${Math.min(i + 400, forS2.length)}/${forS2.length}...`
    );
    try {
      const res = await fetch("/api/abstracts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: chunk }),
      });
      const body = await res.json();
      if (!res.ok) {
        throw new Error(
          typeof body?.error === "string" ? body.error : "request failed"
        );
      }
      (body.results as (string | null)[]).forEach((abs, j) => {
        if (abs && plausibleAbstract(abs)) {
          push(chunk[j], tidy(abs), "Semantic Scholar");
        }
      });
    } catch (e) {
      notes.push(
        `Semantic Scholar was unavailable (${
          e instanceof Error ? e.message : "error"
        }); continuing with Crossref.`
      );
      break;
    }
  }

  // 3) Crossref, one DOI at a time, for the remainder.
  const forCr = dois.filter((d) =>
    (byDoi.get(d) ?? []).some((r) => !found.has(r.id))
  );
  for (let i = 0; i < forCr.length; i++) {
    if (i % 10 === 0) {
      onProgress(`Crossref: checking DOIs ${i + 1}/${forCr.length}...`);
    }
    try {
      const res = await fetch(
        `/api/abstracts?doi=${encodeURIComponent(forCr[i])}`
      );
      if (!res.ok) continue;
      const body = await res.json();
      if (typeof body.abstract === "string") {
        const text = jatsToText(body.abstract);
        if (text && plausibleAbstract(text)) push(forCr[i], text, "Crossref");
      }
    } catch {
      /* skip this DOI */
    }
  }

  // 4) No DOI: match by title in OpenAlex, then follow its DOI.
  for (let i = 0; i < noDoi.length; i++) {
    const r = noDoi[i];
    onProgress(`Title matching ${i + 1}/${noDoi.length} records without DOI...`);
    try {
      const w = await resolveWork(r);
      if (!w) continue;
      const text = reconstructAbstract(w.abstract_inverted_index);
      if (text && plausibleAbstract(text)) {
        found.add(r.id);
        updates.push({
          recordId: r.id,
          abstract: tidy(text),
          source: "OpenAlex (title match)",
        });
        continue;
      }
      const d = normalizeDoi(w.doi);
      if (!d) continue;
      const res = await fetch(`/api/abstracts?doi=${encodeURIComponent(d)}`);
      if (!res.ok) continue;
      const body = await res.json();
      if (typeof body.abstract === "string") {
        const cleaned = jatsToText(body.abstract);
        if (cleaned && plausibleAbstract(cleaned)) {
          found.add(r.id);
          updates.push({
            recordId: r.id,
            abstract: cleaned,
            source: "Crossref (title match)",
          });
        }
      }
    } catch {
      /* skip this record */
    }
  }

  return { updates, notes };
}
