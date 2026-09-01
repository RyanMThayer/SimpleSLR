"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import StageTabs from "@/components/project/StageTabs";
import { createClient } from "@/lib/supabase/client";
import { btnSecondarySm as btn } from "@/lib/ui";
import { plausibleAbstract } from "@/lib/abstracts";
import { fulltextPathFor } from "@/lib/fulltext";
import { normalizeDoi } from "@/lib/normalize";
import type { RecordRow } from "@/lib/types";

type Pair = {
  a: RecordRow;
  b: RecordRow;
  sim: number;
};

export default function DuplicatesClient({
  projectId,
  userId,
}: {
  projectId: string;
  userId: string;
}) {
  const [pairs, setPairs] = useState<Pair[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    const supabase = createClient();
    const { data: rawPairs, error: rpcErr } = await supabase.rpc(
      "find_similar_pairs",
      { p_project: projectId, p_threshold: 0.55 }
    );
    if (rpcErr) {
      setError(
        rpcErr.message.includes("Could not find the function")
          ? "This page needs migration 0005_phase2.sql; run it in the Supabase SQL Editor first."
          : rpcErr.message
      );
      setPairs([]);
      return;
    }
    const rows = (rawPairs ?? []) as { a_id: string; b_id: string; sim: number }[];
    if (rows.length === 0) {
      setPairs([]);
      setError(null);
      return;
    }
    const ids = [...new Set(rows.flatMap((p) => [p.a_id, p.b_id]))];
    const records = new Map<string, RecordRow>();
    for (let i = 0; i < ids.length; i += 100) {
      const { data } = await supabase
        .from("records")
        .select("*")
        .in("id", ids.slice(i, i + 100));
      ((data ?? []) as RecordRow[]).forEach((r) => records.set(r.id, r));
    }
    setPairs(
      rows
        .map((p) => ({
          a: records.get(p.a_id),
          b: records.get(p.b_id),
          sim: p.sim,
        }))
        .filter((p): p is Pair => Boolean(p.a && p.b))
    );
    setError(null);
  }, [projectId]);

  useEffect(() => {
    // Fetch-on-mount: state updates happen after awaits inside load().
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  /**
   * Keep `keeper`, retire `dup` as its duplicate. Before retiring,
   * copy anything the duplicate knows that the keeper is missing:
   * DOI, a plausible abstract, authors, year, venue, link, and the
   * stored PDF. The keeper's own values are never overwritten, and
   * the duplicate stays inspectable under Records with the duplicate
   * status filter.
   */
  async function markDuplicate(dup: RecordRow, keeper: RecordRow) {
    setBusy(true);
    setNotice(null);
    const supabase = createClient();

    const patch: Record<string, unknown> = {};
    const merged: string[] = [];
    if (!keeper.doi?.trim() && dup.doi?.trim()) {
      patch.doi = dup.doi;
      patch.norm_doi = dup.norm_doi ?? normalizeDoi(dup.doi);
      merged.push("DOI");
    }
    if (!plausibleAbstract(keeper.abstract) && plausibleAbstract(dup.abstract)) {
      patch.abstract = dup.abstract;
      merged.push("abstract");
    }
    if (!keeper.authors?.trim() && dup.authors?.trim()) {
      patch.authors = dup.authors;
      merged.push("authors");
    }
    if (keeper.year == null && dup.year != null) {
      patch.year = dup.year;
      merged.push("year");
    }
    if (!keeper.venue?.trim() && dup.venue?.trim()) {
      patch.venue = dup.venue;
      merged.push("venue");
    }
    if (!keeper.url?.trim() && dup.url?.trim()) {
      patch.url = dup.url;
      merged.push("link");
    }
    if (!keeper.fulltext_path && dup.fulltext_path) {
      const dest = fulltextPathFor(projectId, keeper.id);
      const { error: cpErr } = await supabase.storage
        .from("fulltexts")
        .copy(dup.fulltext_path, dest);
      if (!cpErr) {
        patch.fulltext_path = dest;
        merged.push("PDF");
      }
    }

    if (Object.keys(patch).length > 0) {
      const { error: kErr } = await supabase
        .from("records")
        .update(patch)
        .eq("id", keeper.id);
      if (kErr) {
        setError(kErr.message);
        setBusy(false);
        return;
      }
    }
    const { error: upErr } = await supabase
      .from("records")
      .update({ status: "duplicate", duplicate_of: keeper.id })
      .eq("id", dup.id);
    setBusy(false);
    if (upErr) {
      setError(upErr.message);
      return;
    }
    setNotice(
      merged.length > 0
        ? `Kept "${keeper.title.slice(0, 60)}" and copied ${merged.join(", ")} over from the duplicate.`
        : `Kept "${keeper.title.slice(0, 60)}"; the other record is retired as its duplicate.`
    );
    load();
  }

  async function dismiss(pair: Pair) {
    setBusy(true);
    const supabase = createClient();
    const [a, b] = pair.a.id < pair.b.id ? [pair.a.id, pair.b.id] : [pair.b.id, pair.a.id];
    const { error: insErr } = await supabase.from("dismissed_pairs").insert({
      project_id: projectId,
      a,
      b,
      dismissed_by: userId,
    });
    setBusy(false);
    if (insErr && !insErr.message.includes("duplicate key")) {
      setError(insErr.message);
      return;
    }
    setPairs((ps) => ps?.filter((p) => p !== pair) ?? ps);
  }

  const recCard = (r: RecordRow, other: RecordRow, showFull: boolean) => (
    <div className="flex flex-1 flex-col rounded-lg border border-zinc-200 p-3 text-sm dark:border-zinc-700">
      <p className="mb-1 font-medium text-zinc-900 dark:text-zinc-50">{r.title}</p>
      <p className="mb-2 text-xs text-zinc-600 dark:text-zinc-400">
        {[r.authors, r.year, r.venue, r.source_label].filter(Boolean).join(" · ")}
        {r.doi && <> · {r.doi}</>}
        {r.fulltext_path && (
          <>
            {" · "}
            <span className="rounded-full bg-sky-100 px-1.5 py-0.5 text-sky-700 dark:bg-sky-950 dark:text-sky-300">
              PDF
            </span>
          </>
        )}
      </p>
      {r.abstract ? (
        <p
          className={`text-xs leading-5 text-zinc-600 dark:text-zinc-400 ${
            showFull ? "" : "line-clamp-3"
          }`}
        >
          {r.abstract}
        </p>
      ) : (
        <p className="text-xs italic text-zinc-500 dark:text-zinc-500">
          No abstract in the export.
        </p>
      )}
      <div className="mt-auto pt-3">
        <button
          onClick={() => markDuplicate(other, r)}
          disabled={busy}
          title="Keeps this record active; the other one becomes its duplicate. Missing details (DOI, abstract, PDF...) are copied over first."
          className="rounded-md bg-teal-700 px-4 py-1.5 text-xs font-medium text-zinc-50 transition-colors hover:bg-teal-800 disabled:opacity-40 dark:bg-teal-400 dark:text-teal-950 dark:hover:bg-teal-300"
        >
          Keep this one
        </button>
      </div>
    </div>
  );

  const pairKey = (p: Pair) => `${p.a.id}-${p.b.id}`;

  function toggleExpanded(p: Pair) {
    setExpanded((prev) => {
      const next = new Set(prev);
      const key = pairKey(p);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  
  return (
    <main className="mx-auto w-full max-w-4xl flex-1 px-6 py-8">
      <StageTabs
        stage="Records"
        tabs={[
          {
            href: `/projects/${projectId}/records`,
            label: "All records",
            active: false,
          },
          {
            href: `/projects/${projectId}/duplicates`,
            label: "Duplicates",
            active: true,
          },
        ]}
      />
      <h1 className="mb-1 font-serif text-2xl font-semibold text-zinc-900 dark:text-zinc-50">
        Possible duplicates
      </h1>
      <p className="mb-6 text-sm text-zinc-600 dark:text-zinc-300">
        Near matches by title similarity that the automatic import dedup was
        not confident enough to merge. Pick which record to keep: anything the
        other one knows that the kept record is missing (DOI, abstract,
        authors, year, venue, link, stored PDF) is copied over first, the
        kept record&apos;s own values are never overwritten, and the retired
        duplicate stays inspectable under Records. Screening continues on the
        kept record. Dismissing a pair removes it from this list for the
        whole team.
      </p>

      {notice && (
        <p className="mb-4 rounded-lg border border-teal-300 bg-teal-50 px-4 py-3 text-sm text-teal-800 dark:border-teal-800 dark:bg-teal-950 dark:text-teal-200">
          {notice}
        </p>
      )}
      {error && (
        <p className="mb-4 rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
          {error}
        </p>
      )}

      {pairs === null ? (
        <p className="text-zinc-600 dark:text-zinc-400">Comparing titles...</p>
      ) : pairs.length === 0 && !error ? (
        <div className="rounded-xl border border-zinc-200 bg-white p-6 text-center dark:border-zinc-800 dark:bg-zinc-900">
          <p className="mb-2 font-medium text-zinc-900 dark:text-zinc-50">
            No suspicious pairs left.
          </p>
          <p className="mb-3 text-sm text-zinc-600 dark:text-zinc-400">
            Either the corpus is clean or the import dedup already handled it.
          </p>
          <Link
            href={`/projects/${projectId}`}
            className="text-sm underline underline-offset-2"
          >
            Back to the project
          </Link>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {pairs.map((p, i) => (
            <div
              key={`${p.a.id}-${p.b.id}`}
              className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900"
            >
              <div className="mb-2 flex items-center justify-between">
                <p className="text-xs text-zinc-500 dark:text-zinc-400">
                  Pair {i + 1} · title similarity {(p.sim * 100).toFixed(0)}%
                </p>
                {(p.a.abstract || p.b.abstract) && (
                  <button
                    onClick={() => toggleExpanded(p)}
                    className="text-xs text-zinc-500 dark:text-zinc-400 underline underline-offset-2 hover:text-zinc-700 dark:hover:text-zinc-300"
                  >
                    {expanded.has(pairKey(p))
                      ? "Collapse abstracts"
                      : "Show full abstracts"}
                  </button>
                )}
              </div>
              <div className="mb-3 flex flex-col gap-3 sm:flex-row">
                {recCard(p.a, p.b, expanded.has(pairKey(p)))}
                {recCard(p.b, p.a, expanded.has(pairKey(p)))}
              </div>
              <div className="flex flex-wrap gap-2">
                <button onClick={() => dismiss(p)} disabled={busy} className={btn}>
                  Not duplicates
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </main>
  );
}
