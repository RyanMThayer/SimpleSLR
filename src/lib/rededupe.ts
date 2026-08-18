import { createClient } from "@/lib/supabase/client";
import { authorTokens, sharesAuthor } from "@/lib/normalize";
import type { RecordRow } from "./types";

/**
 * When records are deleted, other records that were marked as their
 * duplicates would be stranded: still status "duplicate", but their
 * original gone. These helpers repair that: call collectDependents
 * BEFORE deleting (the FK nulls the pointer on delete), perform the
 * deletion, then call repairDependents. Each dependent is re-checked
 * against the surviving active records with the same rules as import
 * dedup (DOI match, or title match corroborated by a shared author or
 * matching year): it is repointed to a surviving original when one
 * exists, otherwise promoted back to active. Promotions cascade, so
 * when several duplicates of one deleted original survive, the first
 * becomes the new active original and the rest point at it.
 */

export type RepairResult = { promoted: number; repointed: number };

export async function collectDependents(
  projectId: string,
  deletedIds: string[]
): Promise<RecordRow[]> {
  if (deletedIds.length === 0) return [];
  const supabase = createClient();
  const out: RecordRow[] = [];
  for (let i = 0; i < deletedIds.length; i += 100) {
    const { data } = await supabase
      .from("records")
      .select("*")
      .eq("project_id", projectId)
      .eq("status", "duplicate")
      .in("duplicate_of", deletedIds.slice(i, i + 100));
    out.push(...((data ?? []) as RecordRow[]));
  }
  return out;
}

export async function repairDependents(
  projectId: string,
  dependents: RecordRow[],
  deletedIds: Set<string>
): Promise<RepairResult> {
  const survivors = dependents.filter((d) => !deletedIds.has(d.id));
  if (survivors.length === 0) return { promoted: 0, repointed: 0 };
  const supabase = createClient();

  // Key maps of the remaining active records.
  const doiMap = new Map<string, string>();
  type TitleInfo = { id: string; tokens: Set<string>; year: number | null };
  const titleMap = new Map<string, TitleInfo[]>();
  const page = 1000;
  for (let from = 0; ; from += page) {
    const { data, error } = await supabase
      .from("records")
      .select("id, norm_doi, norm_title, authors, year")
      .eq("project_id", projectId)
      .eq("status", "active")
      .range(from, from + page - 1);
    if (error) throw new Error(error.message);
    (data ?? []).forEach((r) => {
      if (r.norm_doi && !doiMap.has(r.norm_doi)) doiMap.set(r.norm_doi, r.id);
      if (r.norm_title) {
        const list = titleMap.get(r.norm_title) ?? [];
        list.push({ id: r.id, tokens: authorTokens(r.authors), year: r.year });
        titleMap.set(r.norm_title, list);
      }
    });
    if (!data || data.length < page) break;
  }

  let promoted = 0;
  let repointed = 0;
  // Oldest first, so the earliest survivor becomes the new original.
  survivors.sort((a, b) => a.created_at.localeCompare(b.created_at));

  for (const rec of survivors) {
    const myTokens = authorTokens(rec.authors);
    let target: string | null = null;
    if (rec.norm_doi && doiMap.has(rec.norm_doi)) {
      target = doiMap.get(rec.norm_doi)!;
    } else if (rec.norm_title) {
      const candidates = titleMap.get(rec.norm_title) ?? [];
      const hit = candidates.find((c) =>
        c.tokens.size > 0 && myTokens.size > 0
          ? sharesAuthor(c.tokens, myTokens)
          : c.year !== null && rec.year !== null && c.year === rec.year
      );
      if (hit) target = hit.id;
    }

    if (target) {
      const { error } = await supabase
        .from("records")
        .update({ duplicate_of: target })
        .eq("id", rec.id);
      if (error) throw new Error(error.message);
      repointed++;
    } else {
      const { error } = await supabase
        .from("records")
        .update({ status: "active", duplicate_of: null })
        .eq("id", rec.id);
      if (error) throw new Error(error.message);
      promoted++;
      // Now active: later survivors can match against it.
      if (rec.norm_doi && !doiMap.has(rec.norm_doi)) {
        doiMap.set(rec.norm_doi, rec.id);
      }
      if (rec.norm_title) {
        const list = titleMap.get(rec.norm_title) ?? [];
        list.push({ id: rec.id, tokens: myTokens, year: rec.year });
        titleMap.set(rec.norm_title, list);
      }
    }
  }

  return { promoted, repointed };
}

/** One-line summary for UI messages; empty string when nothing changed. */
export function repairSummary(r: RepairResult): string {
  const parts: string[] = [];
  if (r.promoted > 0) {
    parts.push(
      `${r.promoted} record(s) that duplicated the deleted ones were restored to active`
    );
  }
  if (r.repointed > 0) {
    parts.push(
      `${r.repointed} duplicate(s) were relinked to surviving originals`
    );
  }
  return parts.length ? ` ${parts.join("; ")}.` : "";
}
