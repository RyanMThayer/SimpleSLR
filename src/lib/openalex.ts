import { normalizeDoi, normalizeTitle } from "./normalize";
import type { ParsedRef, RecordRow } from "./types";

/**
 * OpenAlex client for snowballing (Webster and Watson's go backward /
 * go forward), routed through /api/openalex. Free, keyless API.
 */

export type OaWork = {
  id: string; // https://openalex.org/W...
  doi: string | null;
  display_name: string | null;
  publication_year: number | null;
  cited_by_count: number;
  referenced_works?: string[];
  authorships?: { author?: { display_name?: string | null } }[];
  primary_location?: {
    source?: { display_name?: string | null } | null;
    landing_page_url?: string | null;
  } | null;
  abstract_inverted_index?: Record<string, number[]> | null;
};

const SELECT =
  "id,doi,display_name,publication_year,cited_by_count,referenced_works,authorships,primary_location,abstract_inverted_index";

export async function oa<T>(path: string): Promise<T> {
  const res = await fetch(`/api/openalex?u=${encodeURIComponent(path)}`);
  const body = await res.json();
  if (!res.ok) {
    throw new Error(
      typeof body?.error === "string"
        ? body.error
        : `OpenAlex request failed (${res.status})`
    );
  }
  return body as T;
}

/** Rebuild an abstract from OpenAlex's inverted index format. */
export function reconstructAbstract(
  inv: Record<string, number[]> | null | undefined
): string | null {
  if (!inv) return null;
  const words: string[] = [];
  for (const [word, positions] of Object.entries(inv)) {
    for (const p of positions) words[p] = word;
  }
  const s = words.join(" ").replace(/\s+/g, " ").trim();
  return s || null;
}

/** Map an OpenAlex work to the app's record shape. */
export function workToRef(w: OaWork): ParsedRef {
  return {
    title: w.display_name ?? "(untitled)",
    authors:
      w.authorships
        ?.map((a) => a.author?.display_name)
        .filter((x): x is string => Boolean(x))
        .join("; ") || null,
    year: w.publication_year ?? null,
    venue: w.primary_location?.source?.display_name ?? null,
    abstract: reconstructAbstract(w.abstract_inverted_index),
    doi: w.doi ? w.doi.replace(/^https?:\/\/(dx\.)?doi\.org\//, "") : null,
    url: w.primary_location?.landing_page_url ?? w.id ?? null,
  };
}

/** OpenAlex id tail ("W123...") from a full id URL. */
export function shortId(id: string): string {
  return id.replace(/^https?:\/\/openalex\.org\//, "");
}

export type ResolvableRecord = Pick<
  RecordRow,
  "title" | "doi" | "norm_doi" | "norm_title"
>;

/** Resolve one of our records to an OpenAlex work (DOI first, title fallback). */
export async function resolveWork(record: ResolvableRecord): Promise<OaWork | null> {
  const doi = record.norm_doi ?? normalizeDoi(record.doi);
  if (doi) {
    try {
      const w = await oa<OaWork>(
        `works/doi:${encodeURIComponent(doi)}?select=${SELECT}`
      );
      if (w?.id) return w;
    } catch {
      /* fall through to title search */
    }
  }
  const title = record.title.slice(0, 200);
  try {
    const res = await oa<{ results: OaWork[] }>(
      `works?filter=title.search:${encodeURIComponent(
        // Commas and colons are filter syntax in OpenAlex.
        title.replace(/[,:]/g, " ")
      )}&per-page=5&select=${SELECT}`
    );
    const target = record.norm_title ?? normalizeTitle(record.title);
    return (
      res.results?.find(
        (w) => normalizeTitle(w.display_name ?? "") === target
      ) ?? null
    );
  } catch {
    return null;
  }
}

/** Metadata for a list of OpenAlex ids, batched. */
export async function fetchWorksByIds(ids: string[]): Promise<OaWork[]> {
  const out: OaWork[] = [];
  for (let i = 0; i < ids.length; i += 40) {
    const chunk = ids.slice(i, i + 40).map(shortId).join("|");
    const res = await oa<{ results: OaWork[] }>(
      `works?filter=openalex:${chunk}&per-page=50&select=${SELECT}`
    );
    out.push(...(res.results ?? []));
  }
  return out;
}

export type ForwardResult = {
  works: OaWork[];
  total: number;
  truncated: boolean;
};

/** Works citing the given work, most cited first, capped. */
export async function fetchCiting(
  workId: string,
  cap = 400
): Promise<ForwardResult> {
  const works: OaWork[] = [];
  let cursor = "*";
  let total = 0;
  while (works.length < cap && cursor) {
    const res = await oa<{
      results: OaWork[];
      meta: { count: number; next_cursor: string | null };
    }>(
      `works?filter=cites:${shortId(workId)}&sort=cited_by_count:desc&per-page=200&cursor=${encodeURIComponent(cursor)}&select=${SELECT}`
    );
    total = res.meta?.count ?? works.length;
    works.push(...(res.results ?? []));
    cursor = res.meta?.next_cursor ?? "";
    if (!res.results || res.results.length === 0) break;
  }
  return {
    works: works.slice(0, cap),
    total,
    truncated: total > Math.min(works.length, cap),
  };
}

/** Referenced works (backward direction) of an already resolved work. */
export async function fetchReferenced(work: OaWork): Promise<OaWork[]> {
  const ids = work.referenced_works ?? [];
  if (ids.length === 0) return [];
  return fetchWorksByIds(ids);
}
