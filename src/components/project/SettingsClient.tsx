"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import type { Project } from "@/lib/types";

export default function SettingsClient({ project }: { project: Project }) {
  const [name, setName] = useState(project.name);
  const [includeKw, setIncludeKw] = useState(project.include_keywords.join(", "));
  const [excludeKw, setExcludeKw] = useState(project.exclude_keywords.join(", "));
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

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
        <p className="text-sm text-zinc-600 dark:text-zinc-300">
          The research objective and questions live on the project page. The
          search string and limits live on the Discovery page. The inclusion
          and exclusion criteria and the exclusion reasons live in the
          screening room, next to where decisions get made.
        </p>
        <label className={labelCls}>
          Name
          <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} />
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

      {error && (
        <p className="rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
          {error}
        </p>
      )}
    </main>
  );
}
