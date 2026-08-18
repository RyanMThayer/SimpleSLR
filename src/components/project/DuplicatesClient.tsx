"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
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
  const [busy, setBusy] = useState(false);

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

  async function markDuplicate(dup: RecordRow, original: RecordRow) {
    setBusy(true);
    const supabase = createClient();
    const { error: upErr } = await supabase
      .from("records")
      .update({ status: "duplicate", duplicate_of: original.id })
      .eq("id", dup.id);
    setBusy(false);
    if (upErr) {
      setError(upErr.message);
      return;
    }
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

  const recCard = (r: RecordRow) => (
    <div className="flex-1 rounded-lg border border-zinc-200 p-3 text-sm dark:border-zinc-700">
      <p className="mb-1 font-medium text-zinc-900 dark:text-zinc-50">{r.title}</p>
      <p className="text-xs text-zinc-500 dark:text-zinc-400">
        {[r.authors, r.year, r.venue, r.source_label].filter(Boolean).join(" · ")}
        {r.doi && <> · {r.doi}</>}
      </p>
    </div>
  );

  const btn =
    "rounded-full border border-zinc-300 px-3 py-1.5 text-xs text-zinc-700 transition-colors hover:bg-zinc-100 disabled:opacity-40 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800";

  return (
    <main className="mx-auto w-full max-w-4xl flex-1 px-6 py-8">
      <h1 className="mb-1 text-2xl font-semibold text-zinc-900 dark:text-zinc-50">
        Possible duplicates
      </h1>
      <p className="mb-6 text-sm text-zinc-500 dark:text-zinc-400">
        Near matches by title similarity that the automatic import dedup was
        not confident enough to merge. Marking a record as the duplicate keeps
        the other one active; dismissing a pair removes it from this list for
        the whole team.
      </p>

      {error && (
        <p className="mb-4 rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
          {error}
        </p>
      )}

      {pairs === null ? (
        <p className="text-zinc-500 dark:text-zinc-400">Comparing titles...</p>
      ) : pairs.length === 0 && !error ? (
        <div className="rounded-xl border border-zinc-200 bg-white p-6 text-center dark:border-zinc-800 dark:bg-zinc-900">
          <p className="mb-2 font-medium text-zinc-900 dark:text-zinc-50">
            No suspicious pairs left.
          </p>
          <p className="mb-3 text-sm text-zinc-500 dark:text-zinc-400">
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
              <p className="mb-2 text-xs text-zinc-400">
                Pair {i + 1} · title similarity {(p.sim * 100).toFixed(0)}%
              </p>
              <div className="mb-3 flex flex-col gap-3 sm:flex-row">
                {recCard(p.a)}
                {recCard(p.b)}
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  onClick={() => markDuplicate(p.a, p.b)}
                  disabled={busy}
                  className={btn}
                >
                  Left is the duplicate
                </button>
                <button
                  onClick={() => markDuplicate(p.b, p.a)}
                  disabled={busy}
                  className={btn}
                >
                  Right is the duplicate
                </button>
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
