"use client";

import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import ImportClient from "@/components/project/ImportClient";
import {
  DEFAULT_DATABASES,
  KIND_HINTS,
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

const card =
  "rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900";
const inputCls =
  "rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50";
const primaryBtn =
  "rounded-full bg-zinc-900 px-4 py-2 text-sm font-medium text-zinc-50 transition-colors hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-300";
const ghostBtn =
  "rounded-full border border-zinc-300 px-4 py-2 text-sm text-zinc-700 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800";

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
  const [termInputs, setTermInputs] = useState<Record<number, string>>({});
  const [newDbName, setNewDbName] = useState("");
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
    if (rows.length === 0) {
      // First visit: seed the standard databases.
      const { error: seedErr } = await supabase.from("project_databases").insert(
        DEFAULT_DATABASES.map((d, i) => ({
          project_id: project.id,
          name: d.name,
          kind: d.kind,
          position: i,
        }))
      );
      if (!seedErr) {
        const { data: seeded } = await supabase
          .from("project_databases")
          .select("*")
          .eq("project_id", project.id)
          .order("position");
        rows = (seeded ?? []) as ProjectDatabase[];
      }
    }
    setDatabases(rows);

    const { data: batchRows } = await supabase
      .from("import_batches")
      .select("*")
      .eq("project_id", project.id)
      .order("created_at", { ascending: false });
    setBatches((batchRows ?? []) as ImportBatch[]);

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

  async function deleteBatch(batch: ImportBatch) {
    const ok = window.confirm(
      `Delete this import (${batch.filename ?? "file"}, ${batch.record_count} records)? The records and any screening decisions on them are removed permanently.`
    );
    if (!ok) return;
    const supabase = createClient();
    const { error: recErr } = await supabase
      .from("records")
      .delete()
      .eq("batch_id", batch.id);
    if (recErr) {
      setError(recErr.message);
      return;
    }
    const { error: delErr } = await supabase
      .from("import_batches")
      .delete()
      .eq("id", batch.id);
    if (delErr) {
      setError(delErr.message);
      return;
    }
    setMessage("Import deleted.");
    load();
  }

  async function deleteDatabase(db: ProjectDatabase) {
    const dbBatches = batches.filter((b) => b.database_id === db.id);
    const recordCount = dbBatches.reduce((s, b) => s + b.record_count, 0);
    const ok = window.confirm(
      `Remove ${db.name} from this review? This deletes its ${dbBatches.length} import(s) with ${recordCount} records, including any screening decisions on them.`
    );
    if (!ok) return;
    const supabase = createClient();
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
    setMessage(`${db.name} removed.`);
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
  const unlinkedBatches = batches.filter((b) => b.database_id === null);

  return (
    <main className="mx-auto w-full max-w-4xl flex-1 px-6 py-8">
      <h1 className="mb-1 text-2xl font-semibold text-zinc-900 dark:text-zinc-50">
        Discovery
      </h1>
      <p className="mb-6 text-sm text-zinc-500 dark:text-zinc-400">
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
        <p className="mb-4 rounded-lg border border-emerald-300 bg-emerald-50 px-4 py-3 text-sm text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-200">
          {message}
        </p>
      )}

      {/* ---------------- Search string builder ---------------- */}
      <section className={`${card} mb-6`}>
        <h2 className="mb-1 text-lg font-semibold text-zinc-900 dark:text-zinc-50">
          Search string
        </h2>
        <p className="mb-4 text-sm text-zinc-500 dark:text-zinc-400">
          Concept groups are combined with AND; terms inside a group with OR.
          Phrases get quotes automatically; type * yourself for truncation
          (e.g. refugee*).
        </p>

        {config.groups.map((group, gi) => (
          <div key={gi}>
            {gi > 0 && (
              <p className="my-2 text-center text-xs font-bold tracking-widest text-zinc-400">
                AND
              </p>
            )}
            <div className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-700">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-xs font-semibold uppercase tracking-wide text-zinc-400">
                  Concept {gi + 1}
                </span>
                {config.groups.length > 1 && (
                  <button
                    onClick={() => removeGroup(gi)}
                    className="text-xs text-zinc-400 underline underline-offset-2 hover:text-red-600"
                  >
                    remove group
                  </button>
                )}
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
                      className="text-zinc-400 hover:text-red-600"
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
                        ? "First term, e.g. agent-based model*"
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
          <div className="flex items-center gap-3 text-sm text-zinc-700 dark:text-zinc-300">
            <span className="font-medium">Search in:</span>
            {(["title", "abstract", "keywords"] as const).map((f) => (
              <label key={f} className="flex items-center gap-1">
                <input
                  type="checkbox"
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
          </div>
        </div>
      </section>

      {/* ---------------- Search limits ---------------- */}
      <section className={`${card} mb-6`}>
        <h2 className="mb-1 text-lg font-semibold text-zinc-900 dark:text-zinc-50">
          Search limits
        </h2>
        <p className="mb-4 text-sm text-zinc-500 dark:text-zinc-400">
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
        <h2 className="mb-1 text-lg font-semibold text-zinc-900 dark:text-zinc-50">
          Databases
        </h2>
        <p className="mb-4 text-sm text-zinc-500 dark:text-zinc-400">
          Each database gets the search string translated into its own query
          syntax, using the fields checked above. Record the date and the raw
          hit count when you run the search; both feed the PRISMA diagram.
        </p>

        <div className="flex flex-col gap-4">
          {databases === null ? (
            <p className="text-sm text-zinc-500">Loading databases...</p>
          ) : (
            databases.map((db) => {
              const query = generateQuery(db.kind, config);
              const dbBatches = batches.filter((b) => b.database_id === db.id);
              const imported = dbBatches.reduce((s, b) => s + b.record_count, 0);
              return (
                <div key={db.id} className={card}>
                  <div className="mb-3 flex flex-wrap items-center gap-3">
                    <label className="flex items-center gap-2 font-semibold text-zinc-900 dark:text-zinc-50">
                      <input
                        type="checkbox"
                        checked={db.enabled}
                        onChange={(e) => updateDb(db.id, { enabled: e.target.checked })}
                        title="Part of this review's search strategy"
                      />
                      {db.name}
                    </label>
                    <span className="text-xs text-zinc-400">
                      {imported > 0 ? `${imported} imported` : "nothing imported yet"}
                    </span>
                    <button
                      onClick={() => deleteDatabase(db)}
                      className="ml-auto text-xs text-zinc-400 underline underline-offset-2 hover:text-red-600"
                    >
                      remove database
                    </button>
                  </div>

                  {db.enabled && (
                    <>
                      {query ? (
                        <div className="mb-2">
                          <div className="mb-1 flex items-center justify-between">
                            <span className="text-xs font-semibold uppercase tracking-wide text-zinc-400">
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
                          <p className="mt-1 text-xs text-zinc-400">
                            {KIND_HINTS[db.kind]}
                            {limits && <> Apply in the database UI: {limits}.</>}
                          </p>
                        </div>
                      ) : (
                        <p className="mb-2 text-sm italic text-zinc-400">
                          Add terms to the search string above to generate this
                          database&apos;s query.
                        </p>
                      )}

                      <div className="mb-3 flex flex-wrap items-end gap-3">
                        <label className="flex flex-col gap-1 text-xs font-medium text-zinc-500 dark:text-zinc-400">
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
                        <label className="flex flex-col gap-1 text-xs font-medium text-zinc-500 dark:text-zinc-400">
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
                                className="ml-auto text-zinc-400 underline underline-offset-2 hover:text-red-600"
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

      {/* ---------------- Unlinked imports (pre discovery) ---------------- */}
      {unlinkedBatches.length > 0 && (
        <section className={card}>
          <h2 className="mb-2 text-lg font-semibold text-zinc-900 dark:text-zinc-50">
            Imports not linked to a database
          </h2>
          <p className="mb-3 text-sm text-zinc-500 dark:text-zinc-400">
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
                  className="ml-auto text-zinc-400 underline underline-offset-2 hover:text-red-600"
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
