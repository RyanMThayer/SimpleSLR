"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { mergeKeywords, seedKeywords } from "@/lib/keywordSeed";
import type { Project, SearchConfig } from "@/lib/types";

/**
 * Screening highlight keywords, edited where they act: in the
 * screening room's sidebar. Include terms show green in titles and
 * abstracts, exclude terms red. "Suggest from search string" seeds
 * both lists from the Discovery page's search strategy and never
 * clobbers manual terms; nothing is saved until Save.
 */
export default function HighlightingCard({
  project,
  onSaved,
}: {
  project: Project;
  onSaved: (include: string[], exclude: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [includeKw, setIncludeKw] = useState(
    project.include_keywords.join(", ")
  );
  const [excludeKw, setExcludeKw] = useState(
    project.exclude_keywords.join(", ")
  );
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [seeding, setSeeding] = useState(false);

  function parseKeywords(s: string): string[] {
    return [
      ...new Set(
        s
          .split(",")
          .map((k) => k.trim())
          .filter(Boolean)
      ),
    ];
  }

  async function suggestFromSearch() {
    setSeeding(true);
    setMessage(null);
    setError(null);
    const supabase = createClient();
    const { data, error: qErr } = await supabase
      .from("projects")
      .select("search_config")
      .eq("id", project.id)
      .single();
    setSeeding(false);
    if (qErr) {
      setError(qErr.message);
      return;
    }
    const config = (data?.search_config ?? null) as SearchConfig | null;
    const seeds = seedKeywords(config);
    if (seeds.include.length === 0 && seeds.exclude.length === 0) {
      setMessage(
        "No search strategy found; build the search string on the Discovery page first."
      );
      return;
    }
    const nextInc = mergeKeywords(includeKw, seeds.include);
    const nextExc = mergeKeywords(excludeKw, seeds.exclude);
    const addedInc =
      parseKeywords(nextInc).length - parseKeywords(includeKw).length;
    const addedExc =
      parseKeywords(nextExc).length - parseKeywords(excludeKw).length;
    setIncludeKw(nextInc);
    setExcludeKw(nextExc);
    setMessage(
      addedInc + addedExc === 0
        ? "Every search term is already in the lists; nothing new to add."
        : `Added ${addedInc} include and ${addedExc} exclude term(s) from the search strategy. Edit freely, then Save.`
    );
  }

  async function save() {
    setSaving(true);
    setMessage(null);
    setError(null);
    const include = parseKeywords(includeKw);
    const exclude = parseKeywords(excludeKw);
    const supabase = createClient();
    const { error: upErr } = await supabase
      .from("projects")
      .update({ include_keywords: include, exclude_keywords: exclude })
      .eq("id", project.id);
    setSaving(false);
    if (upErr) {
      setError(upErr.message);
      return;
    }
    setMessage("Saved; highlighting updates immediately.");
    onSaved(include, exclude);
  }

  const inputCls =
    "rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 outline-none focus:border-teal-600 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50";

  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between text-sm font-semibold text-zinc-900 dark:text-zinc-50"
      >
        Highlighting
        <span className="text-xs text-zinc-500 dark:text-zinc-400">
          {open ? "hide" : "show"}
        </span>
      </button>
      {open && (
        <div className="mt-3 flex flex-col gap-3">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-zinc-600 dark:text-zinc-400">
              Green marks include terms, red marks exclude terms.
            </span>
            <button
              onClick={suggestFromSearch}
              disabled={seeding}
              title="Prefill both lists from the Discovery page's search strategy: concept group terms turn green, NOT group terms turn red. Review and Save."
              className="shrink-0 rounded-md border border-zinc-300 px-3 py-1 text-xs text-zinc-700 transition-colors hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              {seeding ? "Reading search..." : "Suggest from search"}
            </button>
          </div>
          <label className="flex flex-col gap-1 text-xs font-medium text-zinc-700 dark:text-zinc-300">
            Include terms (comma separated)
            <input
              className={inputCls}
              placeholder="e-government, digital government"
              value={includeKw}
              onChange={(e) => setIncludeKw(e.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium text-zinc-700 dark:text-zinc-300">
            Exclude terms (comma separated)
            <input
              className={inputCls}
              placeholder="e-commerce, medical"
              value={excludeKw}
              onChange={(e) => setExcludeKw(e.target.value)}
            />
          </label>
          <div className="flex items-center gap-2">
            <button
              onClick={save}
              disabled={saving}
              className="rounded-md bg-teal-700 px-4 py-1.5 text-sm font-medium text-zinc-50 transition-colors hover:bg-teal-800 disabled:opacity-50 dark:bg-teal-400 dark:text-teal-950 dark:hover:bg-teal-300"
            >
              {saving ? "Saving..." : "Save"}
            </button>
            {message && (
              <span className="text-xs text-emerald-600 dark:text-emerald-400">
                {message}
              </span>
            )}
            {error && (
              <span className="text-xs text-red-600 dark:text-red-400">
                {error}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
