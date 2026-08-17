"use client";

import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import type { RecordRow, ScreeningDecision } from "@/lib/types";

const PAGE_SIZE = 50;

type StatusFilter = "all" | "active" | "duplicate";
type DecisionFilter = "all" | "include" | "exclude" | "maybe" | "undecided";

export default function RecordsClient({
  projectId,
  userId,
}: {
  projectId: string;
  userId: string;
}) {
  const [rows, setRows] = useState<RecordRow[] | null>(null);
  const [decisions, setDecisions] = useState<Map<string, ScreeningDecision[]>>(
    new Map()
  );
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<StatusFilter>("active");
  const [decisionFilter, setDecisionFilter] = useState<DecisionFilter>("all");
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(async () => {
    const supabase = createClient();
    let query = supabase
      .from("records")
      .select("*", { count: "exact" })
      .eq("project_id", projectId)
      .order("created_at")
      .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);
    if (status !== "all") query = query.eq("status", status);
    if (search.trim()) query = query.ilike("title", `%${search.trim()}%`);

    const { data, count, error: qErr } = await query;
    if (qErr) {
      setError(qErr.message);
      setRows([]);
      return;
    }
    const records = (data ?? []) as RecordRow[];
    setError(null);
    setTotal(count ?? 0);

    // Decisions for the visible records.
    const ids = records.map((r) => r.id);
    const map = new Map<string, ScreeningDecision[]>();
    if (ids.length > 0) {
      const { data: dec } = await supabase
        .from("screening_decisions")
        .select("*")
        .in("record_id", ids)
        .eq("stage", "title_abstract");
      ((dec ?? []) as ScreeningDecision[]).forEach((d) => {
        const list = map.get(d.record_id) ?? [];
        list.push(d);
        map.set(d.record_id, list);
      });
    }
    setDecisions(map);

    if (decisionFilter === "all") {
      setRows(records);
    } else if (decisionFilter === "undecided") {
      setRows(records.filter((r) => !(map.get(r.id)?.length ?? 0)));
    } else {
      setRows(
        records.filter((r) =>
          (map.get(r.id) ?? []).some((d) => d.decision === decisionFilter)
        )
      );
    }
  }, [projectId, page, search, status, decisionFilter]);

  useEffect(() => {
    // Fetch-on-mount: state updates happen after awaits inside load().
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const badge = (decision: string) =>
    decision === "include"
      ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200"
      : decision === "exclude"
        ? "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200"
        : "bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200";

  const selectCls =
    "h-9 rounded-lg border border-zinc-300 bg-white px-2 text-sm text-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50";

  return (
    <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-8">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <h1 className="mr-auto text-2xl font-semibold text-zinc-900 dark:text-zinc-50">
          Records <span className="text-base font-normal text-zinc-400">({total})</span>
        </h1>
        <input
          className="h-9 w-64 rounded-lg border border-zinc-300 bg-white px-3 text-sm text-zinc-900 outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50"
          placeholder="Search titles..."
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(0);
          }}
        />
        <select
          className={selectCls}
          value={status}
          onChange={(e) => {
            setStatus(e.target.value as StatusFilter);
            setPage(0);
          }}
        >
          <option value="active">Active</option>
          <option value="duplicate">Duplicates</option>
          <option value="all">All statuses</option>
        </select>
        <select
          className={selectCls}
          value={decisionFilter}
          onChange={(e) => setDecisionFilter(e.target.value as DecisionFilter)}
        >
          <option value="all">Any decision</option>
          <option value="include">Included</option>
          <option value="exclude">Excluded</option>
          <option value="maybe">Maybe</option>
          <option value="undecided">Undecided</option>
        </select>
      </div>

      {error && (
        <p className="mb-4 rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
          {error}
        </p>
      )}

      <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
        {rows === null ? (
          <p className="px-5 py-4 text-sm text-zinc-500">Loading...</p>
        ) : rows.length === 0 ? (
          <p className="px-5 py-4 text-sm text-zinc-500">
            No records match these filters.
          </p>
        ) : (
          rows.map((r) => {
            const decs = decisions.get(r.id) ?? [];
            const mine = decs.find((d) => d.decided_by === userId);
            const isOpen = expanded === r.id;
            return (
              <div
                key={r.id}
                className="border-b border-zinc-100 last:border-b-0 dark:border-zinc-800"
              >
                <button
                  onClick={() => setExpanded(isOpen ? null : r.id)}
                  className="flex w-full items-center gap-3 px-5 py-3 text-left hover:bg-zinc-50 dark:hover:bg-zinc-800/50"
                >
                  <span className="flex-1 truncate text-sm font-medium text-zinc-900 dark:text-zinc-50">
                    {r.title}
                  </span>
                  {r.status === "duplicate" && (
                    <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
                      duplicate
                    </span>
                  )}
                  {mine && (
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs ${badge(mine.decision)}`}
                    >
                      {mine.decision}
                    </span>
                  )}
                  <span className="w-12 shrink-0 text-right text-xs text-zinc-400">
                    {r.year ?? ""}
                  </span>
                </button>
                {isOpen && (
                  <div className="px-5 pb-4 text-sm">
                    <p className="mb-1 text-zinc-500 dark:text-zinc-400">
                      {[r.authors, r.venue, r.source_label].filter(Boolean).join(" · ")}
                    </p>
                    {r.abstract && (
                      <p className="mb-2 leading-6 text-zinc-700 dark:text-zinc-300">
                        {r.abstract}
                      </p>
                    )}
                    {decs.length > 0 && (
                      <p className="text-xs text-zinc-500 dark:text-zinc-400">
                        Decisions:{" "}
                        {decs
                          .map((d) => `${d.decision}${d.decided_by === userId ? " (you)" : ""}`)
                          .join(", ")}
                      </p>
                    )}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      <div className="mt-4 flex items-center justify-between text-sm text-zinc-500 dark:text-zinc-400">
        <button
          disabled={page === 0}
          onClick={() => setPage((p) => p - 1)}
          className="rounded-full border border-zinc-300 px-4 py-1.5 disabled:opacity-40 dark:border-zinc-700"
        >
          Previous
        </button>
        <span>
          Page {page + 1} of {totalPages}
        </span>
        <button
          disabled={page + 1 >= totalPages}
          onClick={() => setPage((p) => p + 1)}
          className="rounded-full border border-zinc-300 px-4 py-1.5 disabled:opacity-40 dark:border-zinc-700"
        >
          Next
        </button>
      </div>
    </main>
  );
}
