"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import type { ExclusionReason, Project } from "@/lib/types";

export default function SettingsClient({ project }: { project: Project }) {
  const [name, setName] = useState(project.name);
  const [inclusion, setInclusion] = useState(project.inclusion_criteria ?? "");
  const [exclusion, setExclusion] = useState(project.exclusion_criteria ?? "");
  const [includeKw, setIncludeKw] = useState(project.include_keywords.join(", "));
  const [excludeKw, setExcludeKw] = useState(project.exclude_keywords.join(", "));
  const [reasons, setReasons] = useState<ExclusionReason[]>([]);
  const [newReason, setNewReason] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    (async () => {
      const supabase = createClient();
      const { data } = await supabase
        .from("exclusion_reasons")
        .select("*")
        .eq("project_id", project.id)
        .order("position");
      setReasons((data ?? []) as ExclusionReason[]);
    })();
  }, [project.id]);

  function parseKeywords(s: string): string[] {
    return s
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean);
  }

  async function save() {
    setSaving(true);
    setMessage(null);
    setError(null);
    const supabase = createClient();
    const { error: upErr } = await supabase
      .from("projects")
      .update({
        name: name.trim() || project.name,
        inclusion_criteria: inclusion.trim() || null,
        exclusion_criteria: exclusion.trim() || null,
        include_keywords: parseKeywords(includeKw),
        exclude_keywords: parseKeywords(excludeKw),
      })
      .eq("id", project.id);
    setSaving(false);
    if (upErr) {
      setError(upErr.message);
      return;
    }
    setMessage("Saved. Reload other pages to see the changes.");
  }

  async function addReason(e: React.FormEvent) {
    e.preventDefault();
    if (!newReason.trim()) return;
    const supabase = createClient();
    const { data, error: insErr } = await supabase
      .from("exclusion_reasons")
      .insert({
        project_id: project.id,
        label: newReason.trim(),
        position: reasons.length + 1,
      })
      .select("*")
      .single();
    if (insErr) {
      setError(insErr.message);
      return;
    }
    setReasons([...reasons, data as ExclusionReason]);
    setNewReason("");
  }

  async function removeReason(id: string) {
    const supabase = createClient();
    const { error: delErr } = await supabase
      .from("exclusion_reasons")
      .delete()
      .eq("id", id);
    if (delErr) {
      setError(delErr.message);
      return;
    }
    setReasons(reasons.filter((r) => r.id !== id));
  }

  const inputCls =
    "rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50";
  const labelCls =
    "flex flex-col gap-1 text-sm font-medium text-zinc-700 dark:text-zinc-300";

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-8">
      <h1 className="mb-6 text-2xl font-semibold text-zinc-900 dark:text-zinc-50">
        Project settings
      </h1>

      <div className="mb-6 flex flex-col gap-4 rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
        <label className={labelCls}>
          Name
          <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <p className="text-xs text-zinc-400">
          The research objective and questions live on the project page; the
          search string and search limits live on the Discovery page. Below are
          the screening criteria and tools.
        </p>
        <label className={labelCls}>
          Inclusion criteria
          <textarea
            className={`${inputCls} min-h-20`}
            value={inclusion}
            onChange={(e) => setInclusion(e.target.value)}
          />
        </label>
        <label className={labelCls}>
          Exclusion criteria
          <textarea
            className={`${inputCls} min-h-20`}
            value={exclusion}
            onChange={(e) => setExclusion(e.target.value)}
          />
        </label>
        <label className={labelCls}>
          Highlight keywords, include (comma separated, shown green while screening)
          <input
            className={inputCls}
            placeholder="e-government, digital government, benchmark"
            value={includeKw}
            onChange={(e) => setIncludeKw(e.target.value)}
          />
        </label>
        <label className={labelCls}>
          Highlight keywords, exclude (comma separated, shown red while screening)
          <input
            className={inputCls}
            placeholder="e-commerce, medical"
            value={excludeKw}
            onChange={(e) => setExcludeKw(e.target.value)}
          />
        </label>
        <div className="flex items-center gap-3">
          <button
            onClick={save}
            disabled={saving}
            className="rounded-full bg-zinc-900 px-5 py-2 text-sm font-medium text-zinc-50 transition-colors hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-300"
          >
            {saving ? "Saving..." : "Save"}
          </button>
          {message && (
            <span className="text-sm text-emerald-600 dark:text-emerald-400">{message}</span>
          )}
        </div>
      </div>

      <div className="mb-6 rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
        <h2 className="mb-3 font-semibold text-zinc-900 dark:text-zinc-50">
          Exclusion reasons
        </h2>
        <div className="mb-3 flex flex-col gap-2">
          {reasons.map((r, i) => (
            <div
              key={r.id}
              className="flex items-center gap-3 rounded-lg border border-zinc-200 px-3 py-2 text-sm dark:border-zinc-800"
            >
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded bg-zinc-100 text-xs font-semibold text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                {i + 1}
              </span>
              <span className="flex-1 text-zinc-800 dark:text-zinc-200">{r.label}</span>
              <button
                onClick={() => removeReason(r.id)}
                className="text-xs text-zinc-400 underline underline-offset-2 hover:text-red-600"
              >
                remove
              </button>
            </div>
          ))}
        </div>
        <form onSubmit={addReason} className="flex gap-2">
          <input
            className={`${inputCls} flex-1`}
            placeholder="New exclusion reason"
            value={newReason}
            onChange={(e) => setNewReason(e.target.value)}
          />
          <button
            type="submit"
            className="rounded-full border border-zinc-300 px-4 py-2 text-sm text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            Add
          </button>
        </form>
      </div>

      {error && (
        <p className="rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
          {error}
        </p>
      )}
    </main>
  );
}
