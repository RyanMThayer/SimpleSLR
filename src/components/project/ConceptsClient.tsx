"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { card } from "@/lib/ui";
import { awaitingTeammates, requiredFor, settledOutcome } from "@/lib/outcomes";
import AwaitingNote from "@/components/project/AwaitingNote";
import { fetchResolutions, resKey } from "@/lib/resolutions";
import {
  buildExcerptsCsv,
  buildMatrixCsv,
  cleanQuote,
  seedLabels,
} from "@/lib/concepts";
import { downloadFile, slugify } from "@/lib/export";
import type {
  Concept,
  ConceptExcerpt,
  ConceptTag,
  Project,
  RecordRow,
} from "@/lib/types";

type RowFilter = "reading" | "included";
type Cell = { recordId: string; conceptId: string };

async function fetchPaged<T>(
  build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>
): Promise<T[]> {
  const out: T[] = [];
  const page = 1000;
  for (let from = 0; ; from += page) {
    const { data, error } = await build(from, from + page - 1);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < page) break;
  }
  return out;
}

export default function ConceptsClient({
  project,
  userId,
}: {
  project: Project;
  userId: string;
}) {
  const projectId = project.id;

  const [records, setRecords] = useState<RecordRow[] | null>(null);
  const [ftIncluded, setFtIncluded] = useState<Set<string>>(new Set());
  // Papers mid independent screening quota: hidden from the reading
  // set (title/abstract) or just from the included rows (full text).
  const [awaitingTa, setAwaitingTa] = useState(0);
  const [awaitingFt, setAwaitingFt] = useState(0);
  const [concepts, setConcepts] = useState<Concept[]>([]);
  const [tags, setTags] = useState<ConceptTag[]>([]);
  const [excerpts, setExcerpts] = useState<ConceptExcerpt[]>([]);
  const [rowFilter, setRowFilter] = useState<RowFilter>("reading");
  const [error, setError] = useState<string | null>(null);

  // Matrix evidence panel
  const [cell, setCell] = useState<Cell | null>(null);

  // Concept management
  const [newLabel, setNewLabel] = useState("");
  const [editing, setEditing] = useState<{
    id: string;
    label: string;
    description: string;
  } | null>(null);

  // Quote entry (evidence panel)
  const [quoteFor, setQuoteFor] = useState<string | null>(null);
  const [quoteText, setQuoteText] = useState("");
  const [quotePage, setQuotePage] = useState("");

  const loadPapers = useCallback(async () => {
    const supabase = createClient();
    try {
      const taDecs = await fetchPaged<{ record_id: string; decision: string }>(
        (f, t) =>
          supabase
            .from("screening_decisions")
            .select("record_id, decision")
            .eq("project_id", projectId)
            .eq("stage", "title_abstract")
            .range(f, t)
      );
      const byRecord = new Map<string, { decision: string }[]>();
      for (const d of taDecs) {
        const list = byRecord.get(d.record_id) ?? [];
        list.push(d);
        byRecord.set(d.record_id, list);
      }
      const resMap = await fetchResolutions(supabase, projectId);
      const includeIds = [...byRecord.entries()]
        .filter(
          ([id, decs]) =>
            settledOutcome(
              decs,
              resMap.get(resKey("title_abstract", id)),
              requiredFor(project, "title_abstract")
            ) === "included"
        )
        .map(([id]) => id);
      const recs: RecordRow[] = [];
      for (let i = 0; i < includeIds.length; i += 100) {
        const { data, error: rErr } = await supabase
          .from("records")
          .select("*")
          .eq("status", "active")
          .in("id", includeIds.slice(i, i + 100));
        if (rErr) throw new Error(rErr.message);
        recs.push(...((data ?? []) as RecordRow[]));
      }
      recs.sort((a, b) => a.title.localeCompare(b.title));

      const ftDecs = await fetchPaged<{ record_id: string; decision: string }>(
        (f, t) =>
          supabase
            .from("screening_decisions")
            .select("record_id, decision")
            .eq("project_id", projectId)
            .eq("stage", "full_text")
            .range(f, t)
      );
      const ftByRecord = new Map<string, { decision: string }[]>();
      for (const d of ftDecs) {
        const list = ftByRecord.get(d.record_id) ?? [];
        list.push(d);
        ftByRecord.set(d.record_id, list);
      }
      const ftSet = new Set(
        [...ftByRecord.entries()]
          .filter(
            ([id, decs]) =>
              settledOutcome(
                decs,
                resMap.get(resKey("full_text", id)),
                requiredFor(project, "full_text")
              ) === "included"
          )
          .map(([id]) => id)
      );
      setRecords(recs);
      setFtIncluded(ftSet);
      setRowFilter(ftSet.size > 0 ? "included" : "reading");

      const waitIds = awaitingTeammates({
        ta: byRecord,
        ft: ftByRecord,
        resolutionFor: (stage, id) => resMap.get(resKey(stage, id)),
        taRequired: requiredFor(project, "title_abstract"),
        ftRequired: requiredFor(project, "full_text"),
      });
      // Full text waiters are title/abstract includes, so the active
      // fetch above already vetted them; title/abstract waiters need
      // their own liveness check.
      const recIds = new Set(recs.map((r) => r.id));
      setAwaitingFt(waitIds.ft.filter((id) => recIds.has(id)).length);
      let taLive = 0;
      for (let i = 0; i < waitIds.ta.length; i += 100) {
        const { data } = await supabase
          .from("records")
          .select("id")
          .eq("status", "active")
          .in("id", waitIds.ta.slice(i, i + 100));
        taLive += (data ?? []).length;
      }
      setAwaitingTa(taLive);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load papers.");
    }
  }, [projectId, project]);

  const loadConcepts = useCallback(async () => {
    const supabase = createClient();
    try {
      const [cons, tgs, exs] = await Promise.all([
        fetchPaged<Concept>((f, t) =>
          supabase
            .from("concepts")
            .select("*")
            .eq("project_id", projectId)
            .order("position")
            .order("created_at")
            .range(f, t)
        ),
        fetchPaged<ConceptTag>((f, t) =>
          supabase
            .from("concept_tags")
            .select("*")
            .eq("project_id", projectId)
            .range(f, t)
        ),
        fetchPaged<ConceptExcerpt>((f, t) =>
          supabase
            .from("concept_excerpts")
            .select("*")
            .eq("project_id", projectId)
            .order("created_at")
            .range(f, t)
        ),
      ]);
      setConcepts(cons);
      setTags(tgs);
      setExcerpts(exs);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Could not load concepts.";
      setError(
        msg.includes("does not exist")
          ? "Concept tables are missing: run supabase/migrations/0009_concepts.sql in the Supabase SQL Editor."
          : msg
      );
    }
  }, [projectId]);

  useEffect(() => {
    // Fetch-on-mount: state updates happen after awaits inside the loaders.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadPapers();
    loadConcepts();
  }, [loadPapers, loadConcepts]);

  // ------------------------------------------------------------------
  // Derived maps
  // ------------------------------------------------------------------

  const shownRecords = useMemo(() => {
    if (!records) return [];
    return rowFilter === "included"
      ? records.filter((r) => ftIncluded.has(r.id))
      : records;
  }, [records, rowFilter, ftIncluded]);

  const tagByKey = useMemo(() => {
    const m = new Map<string, ConceptTag>();
    for (const t of tags) m.set(`${t.record_id}:${t.concept_id}`, t);
    return m;
  }, [tags]);

  const excerptsByKey = useMemo(() => {
    const m = new Map<string, ConceptExcerpt[]>();
    for (const e of excerpts) {
      const k = `${e.record_id}:${e.concept_id}`;
      const list = m.get(k) ?? [];
      list.push(e);
      m.set(k, list);
    }
    return m;
  }, [excerpts]);

  const paperCountByConcept = useMemo(() => {
    const shown = new Set(shownRecords.map((r) => r.id));
    const m = new Map<string, number>();
    for (const t of tags) {
      if (!shown.has(t.record_id)) continue;
      m.set(t.concept_id, (m.get(t.concept_id) ?? 0) + 1);
    }
    return m;
  }, [tags, shownRecords]);

  const groupSeedLabels = useMemo(
    () => seedLabels(project.search_config?.groups ?? []),
    [project.search_config]
  );

  // ------------------------------------------------------------------
  // Mutations
  // ------------------------------------------------------------------

  async function addConcept(label: string): Promise<Concept | null> {
    const trimmed = label.trim();
    if (!trimmed) return null;
    const supabase = createClient();
    const position =
      concepts.length > 0 ? Math.max(...concepts.map((c) => c.position)) + 1 : 0;
    const { data, error: err } = await supabase
      .from("concepts")
      .insert({ project_id: projectId, label: trimmed, position, created_by: userId })
      .select()
      .single();
    if (err) {
      setError(err.message);
      return null;
    }
    const row = data as Concept;
    setConcepts((cs) => [...cs, row]);
    return row;
  }

  async function seedFromGroups() {
    const supabase = createClient();
    const rows = groupSeedLabels.map((label, i) => ({
      project_id: projectId,
      label,
      position: i,
      created_by: userId,
    }));
    const { data, error: err } = await supabase
      .from("concepts")
      .insert(rows)
      .select();
    if (err) setError(err.message);
    else setConcepts((data ?? []) as Concept[]);
  }

  async function saveEdit() {
    if (!editing) return;
    const label = editing.label.trim();
    if (!label) return;
    const supabase = createClient();
    const description = editing.description.trim() || null;
    const { error: err } = await supabase
      .from("concepts")
      .update({ label, description })
      .eq("id", editing.id);
    if (err) {
      setError(err.message);
      return;
    }
    setConcepts((cs) =>
      cs.map((c) => (c.id === editing.id ? { ...c, label, description } : c))
    );
    setEditing(null);
  }

  async function deleteConcept(c: Concept) {
    const n = paperCountByConcept.get(c.id) ?? 0;
    if (
      !window.confirm(
        `Delete the concept "${c.label}"? Its ticks and quotes on ${n} paper${
          n === 1 ? "" : "s"
        } are removed for the whole team.`
      )
    )
      return;
    const supabase = createClient();
    const { error: err } = await supabase.from("concepts").delete().eq("id", c.id);
    if (err) {
      setError(err.message);
      return;
    }
    setConcepts((cs) => cs.filter((x) => x.id !== c.id));
    setTags((ts) => ts.filter((t) => t.concept_id !== c.id));
    setExcerpts((es) => es.filter((e) => e.concept_id !== c.id));
    if (cell?.conceptId === c.id) setCell(null);
  }

  async function mergeConcepts(srcId: string, dstId: string) {
    const src = concepts.find((c) => c.id === srcId);
    const dst = concepts.find((c) => c.id === dstId);
    if (!src || !dst) return;
    if (
      !window.confirm(
        `Merge "${src.label}" into "${dst.label}"? All ticks and quotes move over, across every paper and every team member.`
      )
    )
      return;
    const supabase = createClient();
    const { error: err } = await supabase.rpc("merge_concepts", {
      p_src: srcId,
      p_dst: dstId,
    });
    if (err) {
      setError(err.message);
      return;
    }
    setCell(null);
    await loadConcepts();
  }

  async function toggleTag(recordId: string, conceptId: string) {
    const supabase = createClient();
    const existing = tagByKey.get(`${recordId}:${conceptId}`);
    if (existing) {
      const quotes = excerptsByKey.get(`${recordId}:${conceptId}`) ?? [];
      if (
        quotes.length > 0 &&
        !window.confirm(
          `Unticking removes ${quotes.length} attached quote${
            quotes.length === 1 ? "" : "s"
          } for this paper. Continue?`
        )
      )
        return;
      if (quotes.length > 0) {
        const { error: exErr } = await supabase
          .from("concept_excerpts")
          .delete()
          .eq("concept_id", conceptId)
          .eq("record_id", recordId);
        if (exErr) {
          setError(exErr.message);
          return;
        }
      }
      const { error: err } = await supabase
        .from("concept_tags")
        .delete()
        .eq("id", existing.id);
      if (err) {
        setError(err.message);
        return;
      }
      setTags((ts) => ts.filter((t) => t.id !== existing.id));
      setExcerpts((es) =>
        es.filter((e) => !(e.record_id === recordId && e.concept_id === conceptId))
      );
    } else {
      const { data, error: err } = await supabase
        .from("concept_tags")
        .insert({
          project_id: projectId,
          concept_id: conceptId,
          record_id: recordId,
          tagged_by: userId,
        })
        .select()
        .single();
      if (err) {
        setError(err.message);
        return;
      }
      setTags((ts) => [...ts, data as ConceptTag]);
    }
  }

  async function updateTagField(
    tag: ConceptTag,
    field: "unit" | "note",
    raw: string
  ) {
    const value = raw.trim() || null;
    if ((tag[field] ?? null) === value) return;
    const supabase = createClient();
    const { error: err } = await supabase
      .from("concept_tags")
      .update({ [field]: value })
      .eq("id", tag.id);
    if (err) {
      setError(err.message);
      return;
    }
    setTags((ts) =>
      ts.map((t) => (t.id === tag.id ? { ...t, [field]: value } : t))
    );
  }

  async function addExcerpt(recordId: string, conceptId: string) {
    const quote = cleanQuote(quoteText);
    if (!quote) return;
    const supabase = createClient();
    if (!tagByKey.get(`${recordId}:${conceptId}`)) {
      const { data, error: tErr } = await supabase
        .from("concept_tags")
        .insert({
          project_id: projectId,
          concept_id: conceptId,
          record_id: recordId,
          tagged_by: userId,
        })
        .select()
        .single();
      if (tErr) {
        setError(tErr.message);
        return;
      }
      setTags((ts) => [...ts, data as ConceptTag]);
    }
    const pageNum = parseInt(quotePage, 10);
    const { data, error: err } = await supabase
      .from("concept_excerpts")
      .insert({
        project_id: projectId,
        concept_id: conceptId,
        record_id: recordId,
        quote,
        page: Number.isFinite(pageNum) ? pageNum : null,
        added_by: userId,
      })
      .select()
      .single();
    if (err) {
      setError(err.message);
      return;
    }
    setExcerpts((es) => [...es, data as ConceptExcerpt]);
    setQuoteText("");
    setQuotePage("");
    setQuoteFor(null);
  }

  async function deleteExcerpt(e: ConceptExcerpt) {
    if (!window.confirm("Remove this quote?")) return;
    const supabase = createClient();
    const { error: err } = await supabase
      .from("concept_excerpts")
      .delete()
      .eq("id", e.id);
    if (err) {
      setError(err.message);
      return;
    }
    setExcerpts((es) => es.filter((x) => x.id !== e.id));
  }

  // ------------------------------------------------------------------
  // Exports
  // ------------------------------------------------------------------

  const stamp = new Date().toISOString().slice(0, 10);
  const base = `${slugify(project.name)}-${stamp}`;

  function exportMatrix() {
    downloadFile(
      `${base}-concept-matrix.csv`,
      buildMatrixCsv(shownRecords, concepts, tags),
      "text/csv"
    );
  }

  function exportQuotes() {
    downloadFile(
      `${base}-concept-quotes.csv`,
      buildExcerptsCsv(shownRecords, concepts, excerpts),
      "text/csv"
    );
  }

  // ------------------------------------------------------------------
  // Styles
  // ------------------------------------------------------------------

    const ghostBtn =
    "rounded-full border border-zinc-300 px-3 py-1.5 text-xs text-zinc-700 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800";
  const inputCls =
    "rounded-lg border border-zinc-300 bg-white px-2 py-1 text-sm text-zinc-900 focus:outline-none dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100";

  // ------------------------------------------------------------------
  // Shared pieces
  // ------------------------------------------------------------------

  function quoteBox(recordId: string, conceptId: string) {
    const open = quoteFor === `${recordId}:${conceptId}`;
    if (!open) {
      return (
        <button
          onClick={() => {
            setQuoteFor(`${recordId}:${conceptId}`);
            setQuoteText("");
            setQuotePage("");
          }}
          className="text-xs text-zinc-500 underline underline-offset-2 hover:text-zinc-700 dark:hover:text-zinc-300"
        >
          + Add quote
        </button>
      );
    }
    return (
      <div className="mt-1 flex flex-col gap-1">
        <textarea
          value={quoteText}
          onChange={(e) => setQuoteText(e.target.value)}
          placeholder="Paste the passage from the PDF (copy it in the viewer first)"
          rows={3}
          className={`${inputCls} w-full`}
          autoFocus
        />
        <div className="flex items-center gap-2">
          <input
            value={quotePage}
            onChange={(e) => setQuotePage(e.target.value)}
            placeholder="Page"
            className={`${inputCls} w-16`}
          />
          <button
            onClick={() => addExcerpt(recordId, conceptId)}
            disabled={!cleanQuote(quoteText)}
            className={ghostBtn}
          >
            Save quote
          </button>
          <button onClick={() => setQuoteFor(null)} className={ghostBtn}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

  function excerptList(recordId: string, conceptId: string) {
    const list = excerptsByKey.get(`${recordId}:${conceptId}`) ?? [];
    if (list.length === 0) return null;
    return (
      <ul className="mt-1 flex flex-col gap-1">
        {list.map((e) => (
          <li
            key={e.id}
            className="rounded-lg bg-zinc-50 px-2 py-1 text-xs leading-5 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"
          >
            &ldquo;{e.quote}&rdquo;
            {e.page !== null && (
              <span className="text-zinc-500 dark:text-zinc-400"> (p. {e.page})</span>
            )}{" "}
            <button
              onClick={() => deleteExcerpt(e)}
              className="text-zinc-500 dark:text-zinc-400 hover:text-red-600"
              title="Remove quote"
            >
              &times;
            </button>
          </li>
        ))}
      </ul>
    );
  }

  // ------------------------------------------------------------------
  // Coding view
  // ------------------------------------------------------------------

  // ------------------------------------------------------------------
  // Matrix view
  // ------------------------------------------------------------------

  const cellRecord = cell ? shownRecords.find((r) => r.id === cell.recordId) ?? records?.find((r) => r.id === cell.recordId) ?? null : null;
  const cellConcept = cell ? concepts.find((c) => c.id === cell.conceptId) ?? null : null;
  const cellTag = cell ? tagByKey.get(`${cell.recordId}:${cell.conceptId}`) : undefined;

  return (
    <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-8">
      <h1 className="mb-1 text-2xl font-semibold text-zinc-900 dark:text-zinc-50">
        Concept matrix
      </h1>
      <p className="mb-6 max-w-3xl text-sm text-zinc-600 dark:text-zinc-400">
        Webster and Watson&apos;s concept centric synthesis: while reading a
        paper, tick the concepts it discusses and paste passages as evidence.
        The concept list is shared live with your whole team; add, rename,
        and merge freely as reading reshapes it. When new papers stop
        producing new concepts, the matrix is done and the review is written
        one concept at a time.
      </p>

      {error && (
        <p className="mb-4 rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
          {error}
        </p>
      )}

      <section className={`${card} mb-6`}>
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
            Papers:
          </span>
          <label className="flex cursor-pointer items-center gap-1.5 text-sm text-zinc-600 dark:text-zinc-400">
            <input
              type="radio"
              checked={rowFilter === "included"}
              onChange={() => setRowFilter("included")}
            />
            Included after full text ({records ? records.filter((r) => ftIncluded.has(r.id)).length : 0})
          </label>
          <label className="flex cursor-pointer items-center gap-1.5 text-sm text-zinc-600 dark:text-zinc-400">
            <input
              type="radio"
              checked={rowFilter === "reading"}
              onChange={() => setRowFilter("reading")}
            />
            Whole full text reading set ({records?.length ?? 0})
          </label>
          <span className="flex-1" />
          <button
            onClick={exportMatrix}
            disabled={concepts.length === 0 || shownRecords.length === 0}
            className={ghostBtn}
          >
            Matrix CSV
          </button>
          <button
            onClick={exportQuotes}
            disabled={excerpts.length === 0}
            className={ghostBtn}
          >
            Quotes CSV
          </button>
        </div>
      </section>

      <section className={`${card} mb-6`}>
        <h2 className="mb-3 text-sm font-semibold text-zinc-900 dark:text-zinc-50">
          Concepts ({concepts.length})
        </h2>
        {concepts.length === 0 && (
          <p className="mb-3 text-sm text-zinc-600 dark:text-zinc-400">
            No concepts yet. Add your first ones below
            {groupSeedLabels.length > 0 && (
              <>
                {" "}
                or start from your search string&apos;s concept groups; they
                are proto concepts you will split and rename while reading
              </>
            )}
            .
          </p>
        )}
        {concepts.length === 0 && groupSeedLabels.length > 0 && (
          <button onClick={seedFromGroups} className={`${ghostBtn} mb-3`}>
            Seed from search groups ({groupSeedLabels.length})
          </button>
        )}
        <ul className="flex flex-col gap-2">
          {concepts.map((c) => (
            <li
              key={c.id}
              className="flex flex-wrap items-center gap-2 rounded-lg border border-zinc-100 px-3 py-2 dark:border-zinc-800"
            >
              {editing?.id === c.id ? (
                <span className="flex min-w-0 flex-1 flex-col gap-1 sm:flex-row sm:items-center sm:gap-2">
                  <input
                    value={editing.label}
                    onChange={(e) =>
                      setEditing({ ...editing, label: e.target.value })
                    }
                    className={`${inputCls} min-w-0 flex-1`}
                    autoFocus
                  />
                  <input
                    value={editing.description}
                    onChange={(e) =>
                      setEditing({ ...editing, description: e.target.value })
                    }
                    placeholder="Working definition (optional)"
                    className={`${inputCls} min-w-0 flex-1`}
                  />
                  <button onClick={saveEdit} className={ghostBtn}>
                    Save
                  </button>
                  <button onClick={() => setEditing(null)} className={ghostBtn}>
                    Cancel
                  </button>
                </span>
              ) : (
                <>
                  <span
                    className="min-w-0 flex-1 truncate text-sm text-zinc-800 dark:text-zinc-200"
                    title={c.description ?? undefined}
                  >
                    {c.label}
                    {c.description && (
                      <span className="ml-2 text-xs text-zinc-500 dark:text-zinc-400">
                        {c.description}
                      </span>
                    )}
                  </span>
                  <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                    {paperCountByConcept.get(c.id) ?? 0} papers
                  </span>
                  <button
                    onClick={() =>
                      setEditing({
                        id: c.id,
                        label: c.label,
                        description: c.description ?? "",
                      })
                    }
                    className={ghostBtn}
                  >
                    Rename
                  </button>
                  <select
                    value=""
                    onChange={(e) => {
                      if (e.target.value) mergeConcepts(c.id, e.target.value);
                      e.target.value = "";
                    }}
                    className={`${inputCls} text-xs`}
                    title="Merge this concept into another"
                  >
                    <option value="">Merge into...</option>
                    {concepts
                      .filter((x) => x.id !== c.id)
                      .map((x) => (
                        <option key={x.id} value={x.id}>
                          {x.label}
                        </option>
                      ))}
                  </select>
                  <button
                    onClick={() => deleteConcept(c)}
                    className="text-sm text-zinc-500 dark:text-zinc-400 transition-colors hover:text-red-600"
                    title="Delete concept"
                  >
                    &times;
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
        <div className="mt-3 flex items-center gap-2">
          <input
            value={newLabel}
            onChange={(e) => setNewLabel(e.target.value)}
            onKeyDown={async (e) => {
              if (e.key === "Enter") {
                const row = await addConcept(newLabel);
                if (row) setNewLabel("");
              }
            }}
            placeholder="New concept..."
            className={`${inputCls} w-64`}
          />
          <button
            onClick={async () => {
              const row = await addConcept(newLabel);
              if (row) setNewLabel("");
            }}
            disabled={!newLabel.trim()}
            className={ghostBtn}
          >
            Add
          </button>
        </div>
      </section>

      <section className={`${card} mb-6`}>
        <h2 className="mb-3 text-sm font-semibold text-zinc-900 dark:text-zinc-50">
          Matrix ({shownRecords.length} papers)
        </h2>
        <AwaitingNote
          count={rowFilter === "included" ? awaitingTa + awaitingFt : awaitingTa}
          className="-mt-1 mb-3"
        />
        {records === null ? (
          <p className="text-sm text-zinc-500 dark:text-zinc-400">Loading...</p>
        ) : shownRecords.length === 0 ? (
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            {rowFilter === "included"
              ? "No papers are included after full text yet; switch to the whole reading set above to start coding while you read."
              : "No papers have passed title/abstract screening yet."}
          </p>
        ) : concepts.length === 0 ? (
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            Add a first concept above, then open a paper with Code to start
            ticking.
          </p>
        ) : (
          <div className="max-h-[65vh] overflow-auto">
            <table className="w-full border-separate border-spacing-0 text-sm">
              <thead>
                <tr>
                  <th className="sticky left-0 top-0 z-20 bg-white px-2 pb-2 text-left text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400 dark:bg-zinc-900">
                    Paper
                  </th>
                  {concepts.map((c) => (
                    <th
                      key={c.id}
                      className="sticky top-0 z-10 max-w-28 bg-white px-2 pb-2 text-left text-xs font-medium text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400"
                      title={c.description ? `${c.label}: ${c.description}` : c.label}
                    >
                      <span className="block max-w-24 truncate">{c.label}</span>
                    </th>
                  ))}
                  <th className="sticky top-0 z-10 bg-white dark:bg-zinc-900" />
                </tr>
              </thead>
              <tbody>
                {shownRecords.map((r) => (
                  <tr key={r.id}>
                    <td
                      className="sticky left-0 z-10 max-w-72 border-t border-zinc-100 bg-white px-2 py-1.5 dark:border-zinc-800 dark:bg-zinc-900"
                      title={r.title}
                    >
                      <span className="block max-w-64 truncate text-zinc-800 dark:text-zinc-200">
                        {r.title}
                      </span>
                      <span className="text-xs text-zinc-500 dark:text-zinc-400">
                        {[r.year, ftIncluded.has(r.id) ? "included" : null]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                    </td>
                    {concepts.map((c) => {
                      const t = tagByKey.get(`${r.id}:${c.id}`);
                      const q = excerptsByKey.get(`${r.id}:${c.id}`)?.length ?? 0;
                      return (
                        <td
                          key={c.id}
                          className="border-t border-zinc-100 px-2 py-1.5 text-center dark:border-zinc-800"
                        >
                          <button
                            onClick={() =>
                              setCell({ recordId: r.id, conceptId: c.id })
                            }
                            className={
                              t
                                ? "font-medium text-emerald-600 dark:text-emerald-400"
                                : "text-zinc-300 dark:text-zinc-600"
                            }
                            title={
                              t
                                ? `${c.label}${t.unit ? ` (${t.unit})` : ""}${
                                    q ? `, ${q} quote${q === 1 ? "" : "s"}` : ""
                                  }`
                                : `Not ticked: ${c.label}`
                            }
                          >
                            {t ? "✓" : "·"}
                            {q > 0 && (
                              <sup className="ml-0.5 text-[10px]">{q}</sup>
                            )}
                          </button>
                        </td>
                      );
                    })}
                    <td className="border-t border-zinc-100 px-2 py-1.5 text-right dark:border-zinc-800">
                      {ftIncluded.has(r.id) ? (
                        <Link
                          href={`/projects/${projectId}/read?record=${r.id}`}
                          className={ghostBtn}
                          title="Open this paper in the reading room, the one place papers are read and coded"
                        >
                          Code
                        </Link>
                      ) : (
                        <span
                          className="text-xs text-zinc-400 dark:text-zinc-500"
                          title="Joins the reading room once full text screening settles on include; until then, click a matrix cell to tick concepts or paste a quote by hand"
                        >
                          in screening
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {cell && cellRecord && cellConcept && (
        <section className={`${card} mb-6`}>
          <div className="mb-2 flex items-start justify-between gap-3">
            <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">
              {cellConcept.label} &middot; {cellRecord.title}
            </h2>
            <button onClick={() => setCell(null)} className={ghostBtn}>
              Close
            </button>
          </div>
          <div className="flex flex-col gap-2">
            <label className="flex cursor-pointer items-center gap-2 text-sm text-zinc-700 dark:text-zinc-300">
              <input
                type="checkbox"
                checked={Boolean(cellTag)}
                onChange={() => toggleTag(cell.recordId, cell.conceptId)}
              />
              This paper discusses the concept
            </label>
            {cellTag && (
              <div className="flex flex-col gap-2">
                <input
                  key={`u-${cellTag.id}`}
                  defaultValue={cellTag.unit ?? ""}
                  onBlur={(e) => updateTagField(cellTag, "unit", e.target.value)}
                  placeholder="Unit of analysis (optional, e.g. organizational)"
                  className={`${inputCls} w-full max-w-md`}
                />
                <textarea
                  key={`n-${cellTag.id}`}
                  defaultValue={cellTag.note ?? ""}
                  onBlur={(e) => updateTagField(cellTag, "note", e.target.value)}
                  placeholder="Note (optional)"
                  rows={2}
                  className={`${inputCls} w-full max-w-md`}
                />
                {excerptList(cell.recordId, cell.conceptId)}
                {quoteBox(cell.recordId, cell.conceptId)}
              </div>
            )}
          </div>
        </section>
      )}
    </main>
  );
}
