"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { card } from "@/lib/ui";
import ImportClient from "@/components/project/ImportClient";
import { parseSearchString, type ParseResult } from "@/lib/parseSearchString";
import {
  collectDependents,
  repairDependents,
  repairSummary,
} from "@/lib/rededupe";
import { removeFulltextPaths } from "@/lib/fulltext";
import {
  KIND_HINTS,
  STANDARD_DATABASES,
  generateQuery,
  hydrateConfig,
  limitsSummary,
} from "@/lib/searchQuery";
import type {
  ImportBatch,
  Project,
  ProjectDatabase,
  SearchConfig,
} from "@/lib/types";

const inputCls =
  "rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 outline-none focus:border-teal-600 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50";
const primaryBtn =
  "rounded-md bg-teal-700 px-4 py-2 text-sm font-medium text-zinc-50 transition-colors hover:bg-teal-800 disabled:opacity-50 dark:bg-teal-400 dark:text-teal-950 dark:hover:bg-teal-300";
const ghostBtn =
  "rounded-md border border-zinc-300 px-4 py-2 text-sm text-zinc-700 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800";

export default function DiscoveryClient({
  project,
  userId,
}: {
  project: Project;
  userId: string;
}) {
  const [config, setConfig] = useState<SearchConfig>(() =>
    hydrateConfig(project.search_config)
  );
  const [dirty, setDirty] = useState(false);
  const [savingConfig, setSavingConfig] = useState(false);
  const [databases, setDatabases] = useState<ProjectDatabase[] | null>(null);
  const [batches, setBatches] = useState<ImportBatch[]>([]);
  const [seedTitles, setSeedTitles] = useState<Map<string, string>>(new Map());
  const [termInputs, setTermInputs] = useState<Record<number, string>>({});
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState("");
  const [parsed, setParsed] = useState<ParseResult | null>(null);
  const [newDbName, setNewDbName] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [importOpenFor, setImportOpenFor] = useState<string | null>(null);
  const [copiedFor, setCopiedFor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [stats, setStats] = useState<{ active: number; dup: number } | null>(null);

  const load = useCallback(async () => {
    const supabase = createClient();
    const { data: dbRows, error: dbErr } = await supabase
      .from("project_databases")
      .select("*")
      .eq("project_id", project.id)
      .order("position")
      .order("created_at");
    if (dbErr) {
      setError(
        dbErr.message.includes("does not exist") ||
          dbErr.message.includes("schema cache")
          ? "The discovery schema is missing. Run supabase/migrations/0002_discovery.sql in the Supabase SQL Editor, then reload."
          : dbErr.message
      );
      setDatabases([]);
      return;
    }
    let rows = (dbRows ?? []) as ProjectDatabase[];
    // Seed (or top up) the standard database list, all UNCHECKED: the
    // team ticks what they actually search, nothing is preselected.
    // Existing rows are matched by kind for the known syntaxes and by
    // name otherwise, so nothing already configured is duplicated or
    // touched.
    const missing = STANDARD_DATABASES.filter((std) => {
      if (std.kind !== "custom") {
        return !rows.some((r) => r.kind === std.kind);
      }
      return !rows.some(
        (r) => r.name.trim().toLowerCase() === std.name.toLowerCase()
      );
    });
    if (missing.length > 0) {
      const { error: seedErr } = await supabase.from("project_databases").insert(
        missing.map((d, i) => ({
          project_id: project.id,
          name: d.name,
          kind: d.kind,
          enabled: false,
          position: STANDARD_DATABASES.findIndex((s) => s.name === d.name) + i,
        }))
      );
      if (!seedErr) {
        const { data: seeded } = await supabase
          .from("project_databases")
          .select("*")
          .eq("project_id", project.id)
          .order("position")
          .order("created_at");
        rows = (seeded ?? []) as ProjectDatabase[];
      }
    }
    setDatabases(rows);

    const { data: batchRows } = await supabase
      .from("import_batches")
      .select("*")
      .eq("project_id", project.id)
      .order("created_at", { ascending: false });
    const allBatches = (batchRows ?? []) as ImportBatch[];
    setBatches(allBatches);

    // Titles of the seed papers behind snowball batches, so those
    // imports can be shown against the record they came from.
    const seedIds = [
      ...new Set(
        allBatches
          .filter((b) => b.origin?.startsWith("snowball") && b.seed_record_id)
          .map((b) => b.seed_record_id as string)
      ),
    ];
    const titles = new Map<string, string>();
    for (let i = 0; i < seedIds.length; i += 100) {
      const { data: seeds } = await supabase
        .from("records")
        .select("id, title")
        .in("id", seedIds.slice(i, i + 100));
      (seeds ?? []).forEach((s) => titles.set(s.id, s.title));
    }
    setSeedTitles(titles);

    const [act, dup] = await Promise.all([
      supabase
        .from("records")
        .select("id", { count: "exact", head: true })
        .eq("project_id", project.id)
        .eq("status", "active"),
      supabase
        .from("records")
        .select("id", { count: "exact", head: true })
        .eq("project_id", project.id)
        .eq("status", "duplicate"),
    ]);
    setStats({ active: act.count ?? 0, dup: dup.count ?? 0 });
    setError(null);
  }, [project.id]);

  useEffect(() => {
    // Fetch-on-mount: state updates happen after awaits inside load().
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  // ----- search config editing -----

  function updateConfig(next: SearchConfig) {
    setConfig(next);
    setDirty(true);
    setMessage(null);
  }

  function addTerm(groupIdx: number) {
    const term = (termInputs[groupIdx] ?? "").trim();
    if (!term) return;
    const groups = config.groups.map((g, i) =>
      i === groupIdx ? { terms: [...g.terms, term] } : g
    );
    updateConfig({ ...config, groups });
    setTermInputs({ ...termInputs, [groupIdx]: "" });
  }

  function removeTerm(groupIdx: number, termIdx: number) {
    const groups = config.groups.map((g, i) =>
      i === groupIdx ? { terms: g.terms.filter((_, j) => j !== termIdx) } : g
    );
    updateConfig({ ...config, groups });
  }

  function addGroup() {
    updateConfig({ ...config, groups: [...config.groups, { terms: [] }] });
  }

  function removeGroup(groupIdx: number) {
    const groups = config.groups.filter((_, i) => i !== groupIdx);
    updateConfig({ ...config, groups: groups.length ? groups : [{ terms: [] }] });
  }

  function runParse() {
    setParsed(parseSearchString(pasteText));
  }

  function applyParsed(mode: "replace" | "append") {
    if (!parsed || !parsed.ok) return;
    const groups =
      mode === "replace"
        ? parsed.groups
        : [
            ...config.groups.filter((g) => g.terms.length > 0),
            ...parsed.groups,
          ];
    updateConfig({ ...config, groups });
    setPasteOpen(false);
    setPasteText("");
    setParsed(null);
    setMessage(
      'Search string applied to the builder. Review the groups, then click "Save search setup".'
    );
  }

  async function saveConfig() {
    setSavingConfig(true);
    const supabase = createClient();
    const { error: upErr } = await supabase
      .from("projects")
      .update({ search_config: config })
      .eq("id", project.id);
    setSavingConfig(false);
    if (upErr) {
      setError(upErr.message);
      return;
    }
    setDirty(false);
    setMessage("Search setup saved for the whole team.");
  }

  // ----- databases -----

  async function updateDb(id: string, patch: Partial<ProjectDatabase>) {
    const supabase = createClient();
    const { error: upErr } = await supabase
      .from("project_databases")
      .update(patch)
      .eq("id", id);
    if (upErr) {
      setError(upErr.message);
      return;
    }
    setDatabases(
      (dbs) => dbs?.map((d) => (d.id === id ? { ...d, ...patch } : d)) ?? dbs
    );
  }

  async function addDatabase(e: React.FormEvent) {
    e.preventDefault();
    const name = newDbName.trim();
    if (!name) return;
    const supabase = createClient();
    const { error: insErr } = await supabase.from("project_databases").insert({
      project_id: project.id,
      name,
      kind: "custom",
      position: (databases?.length ?? 0) + 10,
    });
    if (insErr) {
      setError(insErr.message);
      return;
    }
    setNewDbName("");
    load();
  }

  /**
   * Deletion mechanics shared by the single delete button and the
   * redundant import cleanup: remove the batch's records, the batch,
   * any stored PDFs, then re-check dedup marks that pointed at the
   * deleted records. Returns an error message or the repair note.
   */
  async function deleteBatchCore(
    batch: ImportBatch
  ): Promise<{ error: string | null; note: string }> {
    const supabase = createClient();
    const { data: idRows } = await supabase
      .from("records")
      .select("id, fulltext_path")
      .eq("batch_id", batch.id);
    const deletedIds = (idRows ?? []).map((r) => r.id);
    const pdfPaths = (idRows ?? [])
      .map((r) => r.fulltext_path)
      .filter((p): p is string => Boolean(p));
    const dependents = await collectDependents(project.id, deletedIds);
    const { error: recErr } = await supabase
      .from("records")
      .delete()
      .eq("batch_id", batch.id);
    if (recErr) return { error: recErr.message, note: "" };
    const { error: delErr } = await supabase
      .from("import_batches")
      .delete()
      .eq("id", batch.id);
    if (delErr) return { error: delErr.message, note: "" };
    await removeFulltextPaths(pdfPaths);
    const repair = await repairDependents(
      project.id,
      dependents,
      new Set(deletedIds)
    );
    return { error: null, note: repairSummary(repair) };
  }

  async function deleteBatch(batch: ImportBatch) {
    const ok = window.confirm(
      `Delete this import (${batch.filename ?? "file"}, ${batch.record_count} records)? The records and any screening decisions on them are removed permanently. Records from other sources that were marked as duplicates of these will be re-checked and restored where appropriate.`
    );
    if (!ok) return;
    try {
      const res = await deleteBatchCore(batch);
      if (res.error) setError(res.error);
      else setMessage(`Import deleted.${res.note}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    load();
  }

  async function removeRedundantImports(extras: ImportBatch[]) {
    const ok = window.confirm(
      `Remove ${extras.length} redundant import(s)? For each file imported more than once for the same seed and direction, the earliest import is kept and the re-uploaded copies (and their duplicate records) are deleted. Dedup marks are re-checked afterwards.`
    );
    if (!ok) return;
    for (const b of extras) {
      try {
        const res = await deleteBatchCore(b);
        if (res.error) {
          setError(res.error);
          load();
          return;
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        load();
        return;
      }
    }
    setMessage(
      `Removed ${extras.length} redundant import(s); the earliest copy of each file was kept.`
    );
    load();
  }

  async function deleteDatabase(db: ProjectDatabase) {
    const dbBatches = batches.filter((b) => b.database_id === db.id);
    const recordCount = dbBatches.reduce((s, b) => s + b.record_count, 0);
    const ok = window.confirm(
      `Remove ${db.name} from this review? This deletes its ${dbBatches.length} import(s) with ${recordCount} records, including any screening decisions on them. Records from other sources that were deduplicated against these will be re-checked and restored where appropriate.`
    );
    if (!ok) return;
    const supabase = createClient();
    const deletedIds: string[] = [];
    const pdfPaths: string[] = [];
    for (const b of dbBatches) {
      const { data: idRows } = await supabase
        .from("records")
        .select("id, fulltext_path")
        .eq("batch_id", b.id);
      (idRows ?? []).forEach((r) => {
        deletedIds.push(r.id);
        if (r.fulltext_path) pdfPaths.push(r.fulltext_path);
      });
    }
    const dependents = await collectDependents(project.id, deletedIds);
    for (const b of dbBatches) {
      const { error: recErr } = await supabase
        .from("records")
        .delete()
        .eq("batch_id", b.id);
      if (recErr) {
        setError(recErr.message);
        return;
      }
    }
    const { error: batchErr } = await supabase
      .from("import_batches")
      .delete()
      .eq("database_id", db.id);
    if (batchErr) {
      setError(batchErr.message);
      return;
    }
    const { error: dbErr } = await supabase
      .from("project_databases")
      .delete()
      .eq("id", db.id);
    if (dbErr) {
      setError(dbErr.message);
      return;
    }
    await removeFulltextPaths(pdfPaths);
    try {
      const repair = await repairDependents(
        project.id,
        dependents,
        new Set(deletedIds)
      );
      setMessage(`${db.name} removed.${repairSummary(repair)}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    load();
  }

  async function copyQuery(db: ProjectDatabase, query: string) {
    try {
      await navigator.clipboard.writeText(query);
      setCopiedFor(db.id);
      setTimeout(() => setCopiedFor(null), 1500);
    } catch {
      /* clipboard unavailable; the text is selectable */
    }
  }

  const limits = limitsSummary(config);
  const snowballBatches = batches.filter((b) =>
    b.origin?.startsWith("snowball")
  );
  // The same FILE imported more than once for the same seed and
  // direction is redundant: keep the earliest, offer to remove the
  // rest. OpenAlex rounds and manual entries have no unique filename
  // and are excluded on purpose (repeats there are legitimate).
  const redundantSnowball = (() => {
    const groups = new Map<string, ImportBatch[]>();
    for (const b of snowballBatches) {
      if (!b.filename || b.filename === "manual entry") continue;
      const k = `${b.seed_record_id}|${b.origin}|${b.filename}|${b.record_count}`;
      const list = groups.get(k) ?? [];
      list.push(b);
      groups.set(k, list);
    }
    const extras: ImportBatch[] = [];
    for (const list of groups.values()) {
      // batches are ordered newest first; the last entry is the
      // original import, everything before it a re-upload.
      if (list.length > 1) extras.push(...list.slice(0, -1));
    }
    return extras;
  })();
  const redundantIds = new Set(redundantSnowball.map((b) => b.id));
  // Truly unlinked: no database AND not a snowball round.
  const unlinkedBatches = batches.filter(
    (b) => b.database_id === null && !b.origin?.startsWith("snowball")
  );

  const isStandard = (db: ProjectDatabase) =>
    db.kind !== "custom" ||
    STANDARD_DATABASES.some(
      (s) => s.name.toLowerCase() === db.name.trim().toLowerCase()
    );
  const stdNoteFor = (db: ProjectDatabase) =>
    STANDARD_DATABASES.find(
      (s) => s.name.toLowerCase() === db.name.trim().toLowerCase()
    )?.note;

  return (
    <main className="mx-auto w-full max-w-4xl flex-1 px-6 py-8">
      <h1 className="mb-1 font-serif text-2xl font-semibold text-zinc-900 dark:text-zinc-50">
        Discovery
      </h1>
      <p className="mb-6 text-sm text-zinc-600 dark:text-zinc-400">
        PRISMA identification: build the search string, apply it in each
        database, and import the results. Everything here is shared with the
        whole team.
        {stats && (
          <>
            {" "}
            So far: {stats.active} unique records, {stats.dup} duplicates
            removed automatically.
          </>
        )}
      </p>

      {error && (
        <p className="mb-4 rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
          {error}
        </p>
      )}
      {message && (
        <p className="mb-4 rounded-lg border border-teal-300 bg-teal-50 px-4 py-3 text-sm text-teal-800 dark:border-teal-800 dark:bg-teal-950 dark:text-teal-200">
          {message}
        </p>
      )}

      {/* ---------------- Search string builder ---------------- */}
      <section className={`${card} mb-6`}>
        <div className="mb-1 flex items-center justify-between">
          <h2 className="font-serif text-lg font-semibold text-zinc-900 dark:text-zinc-50">
            Search string
          </h2>
          <button
            onClick={() => {
              setPasteOpen(!pasteOpen);
              setParsed(null);
            }}
            className={`${ghostBtn} px-3 py-1 text-xs`}
          >
            {pasteOpen ? "Close paste box" : "Paste an existing string"}
          </button>
        </div>
        <p className="mb-4 text-sm text-zinc-600 dark:text-zinc-400">
          Concept groups are combined with AND; terms inside a group with OR.
          Phrases get quotes automatically; type * yourself for truncation
          (an asterisk matches any word ending).
        </p>

        {pasteOpen && (
          <div className="mb-4 rounded-lg border border-dashed border-zinc-300 p-4 dark:border-zinc-700">
            <p className="mb-2 text-sm text-zinc-600 dark:text-zinc-400">
              Paste a boolean search string from a document or another
              database. Handles AND/OR/NOT in any case, parentheses, quoted
              phrases (including Word&apos;s curly quotes), and database
              wrappers like TITLE-ABS-KEY( ) or TS=( ). It becomes editable
              concept groups below.
            </p>
            <textarea
              className={`${inputCls} min-h-24 w-full font-mono text-xs`}
              placeholder={'("term one" OR "term two") AND (other* OR another)'}
              value={pasteText}
              onChange={(e) => {
                setPasteText(e.target.value);
                setParsed(null);
              }}
            />
            <div className="mt-2 flex items-center gap-3">
              <button
                onClick={runParse}
                disabled={!pasteText.trim()}
                className={primaryBtn}
              >
                Parse
              </button>
            </div>

            {parsed && !parsed.ok && (
              <p className="mt-3 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
                {parsed.error}
              </p>
            )}

            {parsed && parsed.ok && (
              <div className="mt-3">
                <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                  Preview: {parsed.groups.length} group(s)
                </p>
                <div className="mb-2 flex flex-col gap-2">
                  {parsed.groups.map((g, i) => (
                    <div
                      key={i}
                      className={`flex flex-wrap items-center gap-1 rounded-lg border p-2 ${
                        g.not
                          ? "border-red-300 dark:border-red-900"
                          : "border-zinc-200 dark:border-zinc-700"
                      }`}
                    >
                      <span className="mr-1 text-xs font-semibold text-zinc-500 dark:text-zinc-400">
                        {g.not ? "NOT" : `G${i + 1}`}
                      </span>
                      {g.terms.map((t, ti) => (
                        <span
                          key={ti}
                          className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs text-zinc-800 dark:bg-zinc-800 dark:text-zinc-200"
                        >
                          {t}
                        </span>
                      ))}
                    </div>
                  ))}
                </div>
                {parsed.warnings.length > 0 && (
                  <ul className="mb-3 flex flex-col gap-1">
                    {parsed.warnings.map((w, i) => (
                      <li
                        key={i}
                        className="rounded-lg bg-amber-50 px-3 py-1.5 text-xs text-amber-800 dark:bg-amber-950 dark:text-amber-200"
                      >
                        {w}
                      </li>
                    ))}
                  </ul>
                )}
                <div className="flex gap-2">
                  <button onClick={() => applyParsed("replace")} className={primaryBtn}>
                    Replace current groups
                  </button>
                  <button onClick={() => applyParsed("append")} className={ghostBtn}>
                    Add below current groups
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {config.groups.map((group, gi) => (
          <div key={gi}>
            {gi > 0 && (
              <p className="my-2 text-center text-xs font-bold tracking-widest text-zinc-500 dark:text-zinc-400">
                {group.not ? "AND NOT" : "AND"}
              </p>
            )}
            <div
              className={`rounded-lg border p-3 ${
                group.not
                  ? "border-red-300 dark:border-red-900"
                  : "border-zinc-200 dark:border-zinc-700"
              }`}
            >
              <div className="mb-2 flex items-center justify-between gap-3">
                <span className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                  {group.not ? `Excluded terms (NOT)` : `Concept ${gi + 1}`}
                </span>
                <div className="flex items-center gap-3">
                  <label className="flex items-center gap-1 text-xs text-zinc-600 dark:text-zinc-400">
                    <input
                      type="checkbox"
                      checked={Boolean(group.not)}
                      onChange={(e) => {
                        const groups = config.groups.map((g, i) =>
                          i === gi ? { ...g, not: e.target.checked } : g
                        );
                        updateConfig({ ...config, groups });
                      }}
                    />
                    NOT (exclude these)
                  </label>
                  {config.groups.length > 1 && (
                    <button
                      onClick={() => removeGroup(gi)}
                      className="text-xs text-zinc-500 dark:text-zinc-400 underline underline-offset-2 hover:text-red-600"
                    >
                      remove group
                    </button>
                  )}
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {group.terms.map((t, ti) => (
                  <span
                    key={ti}
                    className="flex items-center gap-1 rounded-full bg-zinc-100 px-3 py-1 text-sm text-zinc-800 dark:bg-zinc-800 dark:text-zinc-200"
                  >
                    {t}
                    <button
                      onClick={() => removeTerm(gi, ti)}
                      className="text-zinc-500 dark:text-zinc-400 hover:text-red-600"
                      aria-label={`Remove ${t}`}
                    >
                      ×
                    </button>
                  </span>
                ))}
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    addTerm(gi);
                  }}
                  className="flex items-center gap-1"
                >
                  <input
                    className={`${inputCls} h-8 w-56 py-0`}
                    placeholder={
                      group.terms.length === 0
                        ? "First term"
                        : "OR another term..."
                    }
                    value={termInputs[gi] ?? ""}
                    onChange={(e) =>
                      setTermInputs({ ...termInputs, [gi]: e.target.value })
                    }
                  />
                  <button type="submit" className={`${ghostBtn} px-3 py-1`}>
                    Add
                  </button>
                </form>
              </div>
            </div>
          </div>
        ))}

        <div className="mt-3 flex flex-wrap items-center gap-4">
          <button onClick={addGroup} className={ghostBtn}>
            + Concept group (AND)
          </button>
          <div className="flex flex-wrap items-center gap-3 text-sm text-zinc-700 dark:text-zinc-300">
            <span className="font-medium">Search in:</span>
            {(["title", "abstract", "keywords"] as const).map((f) => (
              <label
                key={f}
                className={`flex items-center gap-1 ${config.fields.fullRecord ? "opacity-40" : ""}`}
              >
                <input
                  type="checkbox"
                  disabled={config.fields.fullRecord}
                  checked={config.fields[f]}
                  onChange={(e) =>
                    updateConfig({
                      ...config,
                      fields: { ...config.fields, [f]: e.target.checked },
                    })
                  }
                />
                {f}
              </label>
            ))}
            <label
              className="flex items-center gap-1 border-l border-zinc-200 pl-3 dark:border-zinc-700"
              title="Searches every field the database indexes (Scopus ALL, WoS ALL=, IEEE All Metadata). Broader but noisier than title/abstract/keywords."
            >
              <input
                type="checkbox"
                checked={config.fields.fullRecord}
                onChange={(e) =>
                  updateConfig({
                    ...config,
                    fields: { ...config.fields, fullRecord: e.target.checked },
                  })
                }
              />
              entire record (overrides the three)
            </label>
          </div>
        </div>
      </section>

      {/* ---------------- Search limits ---------------- */}
      <section className={`${card} mb-6`}>
        <h2 className="mb-1 font-serif text-lg font-semibold text-zinc-900 dark:text-zinc-50">
          Search limits
        </h2>
        <p className="mb-4 text-sm text-zinc-600 dark:text-zinc-400">
          Eligibility criteria applied while gathering sources. Set them here
          once, apply them in each database&apos;s own filter UI, and report
          them in your methods section.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-sm font-medium text-zinc-700 dark:text-zinc-300">
            Languages
            <input
              className={inputCls}
              placeholder="e.g. English, German"
              value={config.limits.languages}
              onChange={(e) =>
                updateConfig({
                  ...config,
                  limits: { ...config.limits, languages: e.target.value },
                })
              }
            />
          </label>
          <div className="flex gap-3">
            <label className="flex flex-1 flex-col gap-1 text-sm font-medium text-zinc-700 dark:text-zinc-300">
              Year from
              <input
                type="number"
                className={inputCls}
                placeholder="any"
                value={config.limits.yearFrom ?? ""}
                onChange={(e) =>
                  updateConfig({
                    ...config,
                    limits: {
                      ...config.limits,
                      yearFrom: e.target.value ? parseInt(e.target.value, 10) : null,
                    },
                  })
                }
              />
            </label>
            <label className="flex flex-1 flex-col gap-1 text-sm font-medium text-zinc-700 dark:text-zinc-300">
              Year to
              <input
                type="number"
                className={inputCls}
                placeholder="present"
                value={config.limits.yearTo ?? ""}
                onChange={(e) =>
                  updateConfig({
                    ...config,
                    limits: {
                      ...config.limits,
                      yearTo: e.target.value ? parseInt(e.target.value, 10) : null,
                    },
                  })
                }
              />
            </label>
          </div>
          <label className="flex flex-col gap-1 text-sm font-medium text-zinc-700 dark:text-zinc-300 sm:col-span-2">
            Publication types
            <input
              className={inputCls}
              placeholder="e.g. journal articles, conference papers, book chapters"
              value={config.limits.pubTypes}
              onChange={(e) =>
                updateConfig({
                  ...config,
                  limits: { ...config.limits, pubTypes: e.target.value },
                })
              }
            />
          </label>
          <label className="flex flex-col gap-1 text-sm font-medium text-zinc-700 dark:text-zinc-300 sm:col-span-2">
            Notes on the search strategy
            <textarea
              className={`${inputCls} min-h-16`}
              placeholder="Anything future you (or your methods section) should know"
              value={config.limits.notes}
              onChange={(e) =>
                updateConfig({
                  ...config,
                  limits: { ...config.limits, notes: e.target.value },
                })
              }
            />
          </label>
        </div>
        <div className="mt-4 flex items-center gap-3">
          <button onClick={saveConfig} disabled={savingConfig || !dirty} className={primaryBtn}>
            {savingConfig ? "Saving..." : dirty ? "Save search setup" : "Saved"}
          </button>
        </div>
      </section>

      {/* ---------------- Databases ---------------- */}
      <section className="mb-6">
        <h2 className="mb-1 font-serif text-lg font-semibold text-zinc-900 dark:text-zinc-50">
          Databases
        </h2>
        <p className="mb-4 text-sm text-zinc-600 dark:text-zinc-400">
          Each database gets the search string translated into its own query
          syntax, using the fields checked above. Record the date and the raw
          hit count when you run the search; both feed the PRISMA diagram.
        </p>

        {databases !== null && databases.some((d) => !d.enabled) && (
          <div className="mb-4 rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
              Check a database to add it to the search strategy
            </p>
            <div className="grid gap-x-4 gap-y-1 sm:grid-cols-2 lg:grid-cols-3">
              {databases
                .filter((d) => !d.enabled)
                .map((db) => (
                  <label
                    key={db.id}
                    className="flex items-center gap-2 text-sm text-zinc-700 dark:text-zinc-300"
                    title={stdNoteFor(db) ?? undefined}
                  >
                    <input
                      type="checkbox"
                      checked={false}
                      onChange={() => updateDb(db.id, { enabled: true })}
                    />
                    <span className="truncate">{db.name}</span>
                  </label>
                ))}
            </div>
          </div>
        )}

        <div className="flex flex-col gap-4">
          {databases === null ? (
            <p className="text-sm text-zinc-500">Loading databases...</p>
          ) : (
            databases.filter((d) => d.enabled).map((db) => {
              const query = generateQuery(db.kind, config);
              const dbBatches = batches.filter((b) => b.database_id === db.id);
              const imported = dbBatches.reduce((s, b) => s + b.record_count, 0);
              const note = stdNoteFor(db);
              const removable = !isStandard(db) && dbBatches.length === 0;
              return (
                <div key={db.id} className={card}>
                  <div className="mb-3 flex flex-wrap items-center gap-3">
                    <label className="flex items-center gap-2 font-semibold text-zinc-900 dark:text-zinc-50">
                      <input
                        type="checkbox"
                        checked={db.enabled}
                        onChange={(e) => updateDb(db.id, { enabled: e.target.checked })}
                        title="Uncheck to take this database out of the search strategy (imported records stay)"
                      />
                      {renamingId === db.id ? (
                        <form
                          onSubmit={(e) => {
                            e.preventDefault();
                            if (renameValue.trim()) {
                              updateDb(db.id, { name: renameValue.trim() });
                            }
                            setRenamingId(null);
                          }}
                          className="flex items-center gap-2"
                        >
                          <input
                            className={`${inputCls} h-8 py-0`}
                            value={renameValue}
                            onChange={(e) => setRenameValue(e.target.value)}
                            autoFocus
                          />
                          <button type="submit" className="text-xs underline underline-offset-2">
                            Save
                          </button>
                        </form>
                      ) : (
                        db.name
                      )}
                    </label>
                    <span className="text-xs text-zinc-500 dark:text-zinc-400">
                      {imported > 0 ? `${imported} imported` : "nothing imported yet"}
                    </span>
                    <div className="ml-auto flex items-center gap-3">
                      {renamingId !== db.id && (
                        <button
                          onClick={() => {
                            setRenamingId(db.id);
                            setRenameValue(db.name);
                          }}
                          className="text-xs text-zinc-500 dark:text-zinc-400 underline underline-offset-2 hover:text-zinc-700 dark:hover:text-zinc-300"
                          title="Rename, e.g. to note the exact edition searched"
                        >
                          rename
                        </button>
                      )}
                      {removable && (
                        <button
                          onClick={() => deleteDatabase(db)}
                          className="text-xs text-zinc-500 dark:text-zinc-400 underline underline-offset-2 hover:text-red-600"
                        >
                          remove
                        </button>
                      )}
                    </div>
                  </div>
                  {note && (
                    <p className="mb-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-950 dark:text-amber-200">
                      {note}
                    </p>
                  )}

                  {db.enabled && (
                    <>
                      {query ? (
                        <div className="mb-2">
                          <div className="mb-1 flex items-center justify-between">
                            <span className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                              Query for {db.name}
                            </span>
                            <button
                              onClick={() => copyQuery(db, query)}
                              className="text-xs text-zinc-500 underline underline-offset-2 hover:text-zinc-800 dark:hover:text-zinc-200"
                            >
                              {copiedFor === db.id ? "Copied!" : "Copy"}
                            </button>
                          </div>
                          <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-lg bg-zinc-100 p-3 text-xs leading-5 text-zinc-800 dark:bg-zinc-950 dark:text-zinc-200">
                            {query}
                          </pre>
                          <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                            {KIND_HINTS[db.kind]}
                            {limits && <> Apply in the database UI: {limits}.</>}
                          </p>
                        </div>
                      ) : (
                        <p className="mb-2 text-sm italic text-zinc-500 dark:text-zinc-400">
                          Add terms to the search string above to generate this
                          database&apos;s query.
                        </p>
                      )}

                      <div className="mb-3 flex flex-wrap items-end gap-3">
                        <label className="flex flex-col gap-1 text-xs font-medium text-zinc-600 dark:text-zinc-400">
                          Searched on
                          <input
                            type="date"
                            className={`${inputCls} py-1`}
                            value={db.searched_on ?? ""}
                            onChange={(e) =>
                              updateDb(db.id, { searched_on: e.target.value || null })
                            }
                          />
                        </label>
                        <label className="flex flex-col gap-1 text-xs font-medium text-zinc-600 dark:text-zinc-400">
                          Raw hits reported by {db.name}
                          <input
                            type="number"
                            className={`${inputCls} w-32 py-1`}
                            placeholder="e.g. 214"
                            value={db.raw_hit_count ?? ""}
                            onChange={(e) =>
                              updateDb(db.id, {
                                raw_hit_count: e.target.value
                                  ? parseInt(e.target.value, 10)
                                  : null,
                              })
                            }
                          />
                        </label>
                        <button
                          onClick={() =>
                            setImportOpenFor(importOpenFor === db.id ? null : db.id)
                          }
                          className={primaryBtn}
                        >
                          {importOpenFor === db.id ? "Close import" : `Import into ${db.name}`}
                        </button>
                      </div>

                      {importOpenFor === db.id && (
                        <div className="mb-3 rounded-lg border border-dashed border-zinc-300 p-4 dark:border-zinc-700">
                          <ImportClient
                            projectId={project.id}
                            userId={userId}
                            databaseId={db.id}
                            sourceLabelDefault={db.name}
                            onDone={load}
                          />
                        </div>
                      )}

                      {dbBatches.length > 0 && (
                        <div className="flex flex-col gap-1">
                          {dbBatches.map((b) => (
                            <div
                              key={b.id}
                              className="flex items-center gap-3 rounded-lg bg-zinc-50 px-3 py-2 text-xs text-zinc-600 dark:bg-zinc-950 dark:text-zinc-400"
                            >
                              <span className="truncate">
                                {b.filename ?? "import"} · {b.record_count} records ·{" "}
                                {new Date(b.created_at).toLocaleDateString()}
                              </span>
                              <button
                                onClick={() => deleteBatch(b)}
                                className="ml-auto text-zinc-500 dark:text-zinc-400 underline underline-offset-2 hover:text-red-600"
                              >
                                delete import
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                    </>
                  )}
                </div>
              );
            })
          )}
        </div>

        <form onSubmit={addDatabase} className="mt-4 flex gap-2">
          <input
            className={`${inputCls} flex-1`}
            placeholder="Add another database, e.g. ACM Digital Library"
            value={newDbName}
            onChange={(e) => setNewDbName(e.target.value)}
          />
          <button type="submit" className={ghostBtn}>
            Add database
          </button>
        </form>
      </section>

      {/* ---------------- Citation searching imports ---------------- */}
      {snowballBatches.length > 0 && (
        <section className={`${card} mb-6`}>
          <h2 className="mb-2 font-serif text-lg font-semibold text-zinc-900 dark:text-zinc-50">
            Citation searching (snowballing)
          </h2>
          <p className="mb-3 text-sm text-zinc-600 dark:text-zinc-400">
            Each of these imports is linked to the included paper it was
            snowballed from. Manage seeds and fetch more on the{" "}
            <Link
              href={`/projects/${project.id}/snowball`}
              className="underline underline-offset-2 hover:text-zinc-900 dark:hover:text-zinc-100"
            >
              Snowball page
            </Link>
            .
          </p>
          {redundantSnowball.length > 0 && (
            <div className="mb-3 flex flex-wrap items-center gap-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200">
              <span>
                {redundantSnowball.length} import(s) look like the same file
                uploaded more than once for the same seed.
              </span>
              <button
                onClick={() => removeRedundantImports(redundantSnowball)}
                className="rounded-md border border-amber-400 px-3 py-1 text-sm transition-colors hover:bg-amber-100 dark:border-amber-700 dark:hover:bg-amber-900"
              >
                Remove redundant import(s)
              </button>
            </div>
          )}
          <div className="flex flex-col gap-1">
            {snowballBatches.map((b) => (
              <div
                key={b.id}
                className="flex items-center gap-3 rounded-lg bg-zinc-50 px-3 py-2 text-xs text-zinc-600 dark:bg-zinc-950 dark:text-zinc-400"
              >
                <span className="truncate">
                  <span className="font-medium text-violet-700 dark:text-violet-300">
                    {b.origin === "snowball_backward" ? "Backward" : "Forward"}
                  </span>{" "}
                  from &ldquo;
                  {(b.seed_record_id && seedTitles.get(b.seed_record_id)) ??
                    "deleted paper"}
                  &rdquo;
                  {b.filename && <> · {b.filename}</>} · {b.record_count}{" "}
                  records · {new Date(b.created_at).toLocaleDateString()}
                </span>
                {redundantIds.has(b.id) && (
                  <span className="shrink-0 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-900 dark:text-amber-200">
                    re-upload
                  </span>
                )}
                <button
                  onClick={() => deleteBatch(b)}
                  className="ml-auto text-zinc-500 dark:text-zinc-400 underline underline-offset-2 hover:text-red-600"
                >
                  delete import
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ---------------- Unlinked imports (pre discovery) ---------------- */}
      {unlinkedBatches.length > 0 && (
        <section className={card}>
          <h2 className="mb-2 font-serif text-lg font-semibold text-zinc-900 dark:text-zinc-50">
            Imports not linked to a database
          </h2>
          <p className="mb-3 text-sm text-zinc-600 dark:text-zinc-400">
            These were imported before databases were tracked. Link them by
            deleting and re-importing under the right database, or keep them as
            they are.
          </p>
          <div className="flex flex-col gap-1">
            {unlinkedBatches.map((b) => (
              <div
                key={b.id}
                className="flex items-center gap-3 rounded-lg bg-zinc-50 px-3 py-2 text-xs text-zinc-600 dark:bg-zinc-950 dark:text-zinc-400"
              >
                <span className="truncate">
                  {b.source_label ?? b.filename ?? "import"} · {b.record_count}{" "}
                  records · {new Date(b.created_at).toLocaleDateString()}
                </span>
                <button
                  onClick={() => deleteBatch(b)}
                  className="ml-auto text-zinc-500 dark:text-zinc-400 underline underline-offset-2 hover:text-red-600"
                >
                  delete import
                </button>
              </div>
            ))}
          </div>
        </section>
      )}
    </main>
  );
}
