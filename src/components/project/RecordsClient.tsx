"use client";

import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { normalizeTitle, normalizeDoi } from "@/lib/normalize";
import {
  collectDependents,
  repairDependents,
  repairSummary,
} from "@/lib/rededupe";
import type {
  ExclusionReason,
  ImportBatch,
  RecordRow,
  ScreeningDecision,
} from "@/lib/types";

const PAGE_SIZE = 50;

type StatusFilter = "all" | "active" | "duplicate";
type DecisionFilter = "all" | "include" | "exclude" | "undecided";

type SourceSummary = {
  key: string; // database id, or "unlinked"
  name: string;
  batchIds: string[];
  imported: number;
  duplicates: number;
};

type EditForm = {
  title: string;
  authors: string;
  year: string;
  venue: string;
  abstract: string;
  doi: string;
  url: string;
};

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
  const [sources, setSources] = useState<SourceSummary[] | null>(null);
  const [reasons, setReasons] = useState<ExclusionReason[]>([]);
  const [sourceFilter, setSourceFilter] = useState<string>("all");
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<StatusFilter>("active");
  const [decisionFilter, setDecisionFilter] = useState<DecisionFilter>("all");
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<EditForm | null>(null);
  const [saving, setSaving] = useState(false);

  const loadSources = useCallback(async () => {
    const supabase = createClient();
    const [dbRes, batchRes, reasonRes] = await Promise.all([
      supabase
        .from("project_databases")
        .select("id, name")
        .eq("project_id", projectId),
      supabase
        .from("import_batches")
        .select("*")
        .eq("project_id", projectId),
      supabase
        .from("exclusion_reasons")
        .select("*")
        .eq("project_id", projectId)
        .order("position"),
    ]);
    const dbs = (dbRes.data ?? []) as { id: string; name: string }[];
    const allBatches = (batchRes.data ?? []) as ImportBatch[];
    setReasons((reasonRes.data ?? []) as ExclusionReason[]);

    const raw: SourceSummary[] = [];
    for (const db of dbs) {
      const ids = allBatches
        .filter((b) => b.database_id === db.id)
        .map((b) => b.id);
      if (ids.length === 0) continue;
      raw.push({
        key: db.id,
        name: db.name,
        batchIds: ids,
        imported: allBatches
          .filter((b) => b.database_id === db.id)
          .reduce((s, b) => s + b.record_count, 0),
        duplicates: 0,
      });
    }
    const unlinkedIds = allBatches
      .filter((b) => b.database_id === null)
      .map((b) => b.id);
    if (unlinkedIds.length > 0) {
      raw.push({
        key: "unlinked",
        name: "Unlinked imports",
        batchIds: unlinkedIds,
        imported: allBatches
          .filter((b) => b.database_id === null)
          .reduce((s, b) => s + b.record_count, 0),
        duplicates: 0,
      });
    }

    const withDups = await Promise.all(
      raw.map(async (s) => {
        const { count } = await supabase
          .from("records")
          .select("id", { count: "exact", head: true })
          .eq("project_id", projectId)
          .eq("status", "duplicate")
          .in("batch_id", s.batchIds);
        return { ...s, duplicates: count ?? 0 };
      })
    );
    setSources(withDups);
  }, [projectId]);

  const load = useCallback(async () => {
    const supabase = createClient();
    let batchIds: string[] | null = null;
    if (sourceFilter !== "all") {
      const src = sources?.find((s) => s.key === sourceFilter);
      batchIds = src?.batchIds ?? [];
      if (batchIds.length === 0) {
        setRows([]);
        setTotal(0);
        return;
      }
    }

    let query = supabase
      .from("records")
      .select("*", { count: "exact" })
      .eq("project_id", projectId)
      .order("created_at")
      .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);
    if (status !== "all") query = query.eq("status", status);
    if (search.trim()) query = query.ilike("title", `%${search.trim()}%`);
    if (batchIds) query = query.in("batch_id", batchIds);

    const { data, count, error: qErr } = await query;
    if (qErr) {
      setError(qErr.message);
      setRows([]);
      return;
    }
    const records = (data ?? []) as RecordRow[];
    setError(null);
    setTotal(count ?? 0);

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
  }, [projectId, page, search, status, decisionFilter, sourceFilter, sources]);

  useEffect(() => {
    // Fetch-on-mount: state updates happen after awaits inside loadSources().
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadSources();
  }, [loadSources]);

  useEffect(() => {
    // Fetch-on-mount: state updates happen after awaits inside load().
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  async function deleteSource(src: SourceSummary) {
    const ok = window.confirm(
      `Delete all ${src.imported} records imported from ${src.name}, including any screening decisions on them? Records from other sources that were deduplicated against these will be re-checked and restored where appropriate. The database itself stays available for a fresh import. This cannot be undone.`
    );
    if (!ok) return;
    const supabase = createClient();
    const deletedIds: string[] = [];
    for (let i = 0; i < src.batchIds.length; i += 100) {
      const { data: idRows } = await supabase
        .from("records")
        .select("id")
        .in("batch_id", src.batchIds.slice(i, i + 100));
      (idRows ?? []).forEach((r) => deletedIds.push(r.id));
    }
    const dependents = await collectDependents(projectId, deletedIds);
    const { error: recErr } = await supabase
      .from("records")
      .delete()
      .in("batch_id", src.batchIds);
    if (recErr) {
      setError(recErr.message);
      return;
    }
    const { error: batchErr } = await supabase
      .from("import_batches")
      .delete()
      .in("id", src.batchIds);
    if (batchErr) {
      setError(batchErr.message);
      return;
    }
    try {
      await repairDependents(projectId, dependents, new Set(deletedIds));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    if (sourceFilter === src.key) setSourceFilter("all");
    setPage(0);
    loadSources();
    load();
  }

  function startEdit(r: RecordRow) {
    setEditingId(r.id);
    setForm({
      title: r.title,
      authors: r.authors ?? "",
      year: r.year?.toString() ?? "",
      venue: r.venue ?? "",
      abstract: r.abstract ?? "",
      doi: r.doi ?? "",
      url: r.url ?? "",
    });
  }

  async function saveEdit(recordId: string) {
    if (!form || !form.title.trim()) return;
    setSaving(true);
    const supabase = createClient();
    const yearMatch = form.year.match(/\d{4}/);
    const { error: upErr } = await supabase
      .from("records")
      .update({
        title: form.title.trim(),
        authors: form.authors.trim() || null,
        year: yearMatch ? parseInt(yearMatch[0], 10) : null,
        venue: form.venue.trim() || null,
        abstract: form.abstract.trim() || null,
        doi: form.doi.trim() || null,
        url: form.url.trim() || null,
        norm_title: normalizeTitle(form.title),
        norm_doi: normalizeDoi(form.doi.trim() || null),
      })
      .eq("id", recordId);
    setSaving(false);
    if (upErr) {
      setError(upErr.message);
      return;
    }
    setEditingId(null);
    setForm(null);
    load();
  }

  async function deleteRecord(r: RecordRow) {
    const ok = window.confirm(
      `Delete "${r.title.slice(0, 60)}..."? Screening decisions on it are removed too. This cannot be undone.`
    );
    if (!ok) return;
    const supabase = createClient();
    const dependents = await collectDependents(projectId, [r.id]);
    const { error: delErr } = await supabase
      .from("records")
      .delete()
      .eq("id", r.id);
    if (delErr) {
      setError(delErr.message);
      return;
    }
    try {
      const repair = await repairDependents(
        projectId,
        dependents,
        new Set([r.id])
      );
      const note = repairSummary(repair);
      if (note) setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    setExpanded(null);
    loadSources();
    load();
  }

  async function toggleDuplicate(r: RecordRow) {
    const supabase = createClient();
    const { error: upErr } = await supabase
      .from("records")
      .update({
        status: r.status === "duplicate" ? "active" : "duplicate",
        duplicate_of: null,
      })
      .eq("id", r.id);
    if (upErr) {
      setError(upErr.message);
      return;
    }
    loadSources();
    load();
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const totalDuplicates = sources?.reduce((s, x) => s + x.duplicates, 0) ?? 0;

  const badge = (decision: string) =>
    decision === "include"
      ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200"
      : "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200";

  // E# codes derived from the live reason list, so they always match the
  // numbering shown in the screening room (deleted reasons reset their
  // decisions, so no stale codes can appear).
  const reasonCode = new Map<string, { code: string; label: string }>(
    reasons.map((r, i) => [r.id, { code: `E${i + 1}`, label: r.label }])
  );
  const decisionText = (d: ScreeningDecision) => {
    if (d.decision === "include") return { text: "include", tip: "Included" };
    const rc = d.reason_id ? reasonCode.get(d.reason_id) : null;
    return rc
      ? { text: `exclude: ${rc.code}`, tip: rc.label }
      : { text: "exclude", tip: "Excluded without a specific reason" };
  };

  const selectCls =
    "h-9 rounded-lg border border-zinc-300 bg-white px-2 text-sm text-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50";
  const inputCls =
    "w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50";
  const linkBtn = "text-xs underline underline-offset-2";

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
          <option value="undecided">Undecided</option>
        </select>
      </div>

      {sources !== null && sources.length > 0 && (
        <div className="mb-4 rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
          <div className="mb-2 flex items-center justify-between">
            <p className="text-xs font-semibold uppercase tracking-wide text-zinc-400">
              Sources
            </p>
            <p className="text-xs text-zinc-400">
              {totalDuplicates} duplicates across all sources
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => {
                setSourceFilter("all");
                setPage(0);
              }}
              className={`rounded-full border px-3 py-1.5 text-xs transition-colors ${
                sourceFilter === "all"
                  ? "border-zinc-900 bg-zinc-900 text-zinc-50 dark:border-zinc-50 dark:bg-zinc-50 dark:text-zinc-900"
                  : "border-zinc-300 text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800"
              }`}
            >
              All sources
            </button>
            {sources.map((s) => (
              <span
                key={s.key}
                className={`flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs transition-colors ${
                  sourceFilter === s.key
                    ? "border-zinc-900 bg-zinc-900 text-zinc-50 dark:border-zinc-50 dark:bg-zinc-50 dark:text-zinc-900"
                    : "border-zinc-300 text-zinc-600 dark:border-zinc-700 dark:text-zinc-400"
                }`}
              >
                <button
                  onClick={() => {
                    setSourceFilter(sourceFilter === s.key ? "all" : s.key);
                    setPage(0);
                  }}
                  className="hover:underline"
                  title="Show only records from this source"
                >
                  {s.name}: {s.imported}
                  {s.duplicates > 0 && <> ({s.duplicates} dup)</>}
                </button>
                <button
                  onClick={() => deleteSource(s)}
                  className="opacity-60 hover:opacity-100"
                  title={`Delete all records imported from ${s.name}`}
                  aria-label={`Delete all records from ${s.name}`}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        </div>
      )}

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
            const isEditing = editingId === r.id && form !== null;
            return (
              <div
                key={r.id}
                className="border-b border-zinc-100 last:border-b-0 dark:border-zinc-800"
              >
                <button
                  onClick={() => {
                    setExpanded(isOpen ? null : r.id);
                    setEditingId(null);
                  }}
                  className="flex w-full items-center gap-3 px-5 py-3 text-left hover:bg-zinc-50 dark:hover:bg-zinc-800/50"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-zinc-900 dark:text-zinc-50">
                      {r.title}
                    </span>
                    {r.authors && (
                      <span className="block truncate text-xs text-zinc-500 dark:text-zinc-400">
                        {r.authors}
                      </span>
                    )}
                  </span>
                  {r.source_label && (
                    <span className="hidden max-w-32 truncate rounded-full bg-zinc-100 px-2 py-0.5 text-xs text-zinc-500 sm:inline dark:bg-zinc-800 dark:text-zinc-400">
                      {r.source_label}
                    </span>
                  )}
                  {r.status === "duplicate" && (
                    <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
                      duplicate
                    </span>
                  )}
                  {mine && (
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs ${badge(mine.decision)}`}
                      title={decisionText(mine).tip}
                    >
                      {decisionText(mine).text}
                    </span>
                  )}
                  <span className="w-12 shrink-0 text-right text-xs text-zinc-400">
                    {r.year ?? ""}
                  </span>
                </button>

                {isOpen && !isEditing && (
                  <div className="px-5 pb-4 text-sm">
                    <p className="mb-1 text-zinc-500 dark:text-zinc-400">
                      {[r.authors, r.venue, r.source_label].filter(Boolean).join(" · ")}
                      {r.doi && <> · DOI: {r.doi}</>}
                    </p>
                    {r.abstract && (
                      <p className="mb-2 leading-6 text-zinc-700 dark:text-zinc-300">
                        {r.abstract}
                      </p>
                    )}
                    {decs.length > 0 && (
                      <p className="mb-2 text-xs text-zinc-500 dark:text-zinc-400">
                        Decisions:{" "}
                        {decs
                          .map((d) => {
                            const dt = decisionText(d);
                            const reason =
                              d.decision === "exclude" && d.reason_id
                                ? ` (${reasonCode.get(d.reason_id)?.label ?? "removed reason"})`
                                : "";
                            return `${dt.text}${reason}${d.decided_by === userId ? " (you)" : ""}`;
                          })
                          .join(", ")}
                      </p>
                    )}
                    <div className="flex gap-4">
                      <button
                        onClick={() => startEdit(r)}
                        className={`${linkBtn} text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200`}
                      >
                        Edit
                      </button>
                      <button
                        onClick={() => toggleDuplicate(r)}
                        className={`${linkBtn} text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200`}
                      >
                        {r.status === "duplicate" ? "Mark as unique" : "Mark as duplicate"}
                      </button>
                      <button
                        onClick={() => deleteRecord(r)}
                        className={`${linkBtn} text-zinc-400 hover:text-red-600`}
                      >
                        Delete record
                      </button>
                    </div>
                  </div>
                )}

                {isOpen && isEditing && form && (
                  <div className="flex flex-col gap-2 px-5 pb-4 text-sm">
                    <input
                      className={inputCls}
                      value={form.title}
                      onChange={(e) => setForm({ ...form, title: e.target.value })}
                      placeholder="Title"
                    />
                    <div className="grid gap-2 sm:grid-cols-2">
                      <input
                        className={inputCls}
                        value={form.authors}
                        onChange={(e) => setForm({ ...form, authors: e.target.value })}
                        placeholder="Authors"
                      />
                      <input
                        className={inputCls}
                        value={form.venue}
                        onChange={(e) => setForm({ ...form, venue: e.target.value })}
                        placeholder="Venue"
                      />
                      <input
                        className={inputCls}
                        value={form.year}
                        onChange={(e) => setForm({ ...form, year: e.target.value })}
                        placeholder="Year"
                      />
                      <input
                        className={inputCls}
                        value={form.doi}
                        onChange={(e) => setForm({ ...form, doi: e.target.value })}
                        placeholder="DOI"
                      />
                    </div>
                    <input
                      className={inputCls}
                      value={form.url}
                      onChange={(e) => setForm({ ...form, url: e.target.value })}
                      placeholder="URL"
                    />
                    <textarea
                      className={`${inputCls} min-h-24`}
                      value={form.abstract}
                      onChange={(e) => setForm({ ...form, abstract: e.target.value })}
                      placeholder="Abstract"
                    />
                    <div className="flex gap-3">
                      <button
                        onClick={() => saveEdit(r.id)}
                        disabled={saving || !form.title.trim()}
                        className="rounded-full bg-zinc-900 px-4 py-1.5 text-xs font-medium text-zinc-50 disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-900"
                      >
                        {saving ? "Saving..." : "Save changes"}
                      </button>
                      <button
                        onClick={() => {
                          setEditingId(null);
                          setForm(null);
                        }}
                        className={`${linkBtn} text-zinc-400`}
                      >
                        Cancel
                      </button>
                    </div>
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
