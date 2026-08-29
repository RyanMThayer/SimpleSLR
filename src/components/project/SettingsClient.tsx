"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import ApiKeysCard from "@/components/project/ApiKeysCard";
import { mergeKeywords, seedKeywords } from "@/lib/keywordSeed";
import type { Project, SearchConfig } from "@/lib/types";

export default function SettingsClient({ project }: { project: Project }) {
  const [name, setName] = useState(project.name);
  const [includeKw, setIncludeKw] = useState(project.include_keywords.join(", "));
  const [excludeKw, setExcludeKw] = useState(project.exclude_keywords.join(", "));
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Independent screening: opinions required per record and stage.
  const [reqTa, setReqTa] = useState(project.required_opinions_ta ?? 1);
  const [reqFt, setReqFt] = useState(project.required_opinions_ft ?? 1);
  const [savingReq, setSavingReq] = useState(false);
  const [reqMsg, setReqMsg] = useState<string | null>(null);
  const independent = reqTa > 1 || reqFt > 1;

  async function saveOpinions(nextTa: number, nextFt: number) {
    setSavingReq(true);
    setReqMsg(null);
    setError(null);
    const supabase = createClient();
    const { error: upErr } = await supabase
      .from("projects")
      .update({
        required_opinions_ta: nextTa,
        required_opinions_ft: nextFt,
      })
      .eq("id", project.id);
    setSavingReq(false);
    if (upErr) {
      setError(
        upErr.message.includes("required_opinions")
          ? "Run supabase/migrations/0017_independent_screening.sql in the Supabase SQL Editor first, then save again."
          : upErr.message
      );
      return;
    }
    setReqTa(nextTa);
    setReqFt(nextFt);
    setReqMsg("Saved. Screening queues follow the new rule on next load.");
  }

  function parseKeywords(s: string): string[] {
    return s
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean);
  }

  // Fill the highlight fields from the Discovery page's search
  // strategy: normal concept groups suggest green terms, NOT groups
  // red ones. Nothing is saved until the user reviews and hits Save.
  const [seeding, setSeeding] = useState(false);
  async function suggestFromSearch() {
    setSeeding(true);
    setMessage(null);
    setError(null);
    const supabase = createClient();
    // Fetch fresh: the search string may have been edited on the
    // Discovery page since this page loaded.
    const { data } = await supabase
      .from("projects")
      .select("search_config")
      .eq("id", project.id)
      .single();
    const config = (data?.search_config ??
      project.search_config) as Partial<SearchConfig> | null;
    const seeds = seedKeywords(config);
    setSeeding(false);
    if (seeds.include.length === 0 && seeds.exclude.length === 0) {
      setMessage(
        "The search strategy on the Discovery page has no terms yet, so there is nothing to suggest."
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
    "rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 outline-none focus:border-teal-600 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50";
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
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
            Screening highlights
          </span>
          <button
            onClick={suggestFromSearch}
            disabled={seeding}
            title="Prefill both lists from the Discovery page's search strategy: concept group terms turn green, NOT group terms turn red. Review and Save."
            className="rounded-full border border-zinc-300 px-3 py-1 text-sm text-zinc-700 transition-colors hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            {seeding ? "Reading search..." : "Suggest from search string"}
          </button>
        </div>
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
            className="rounded-full bg-teal-700 px-5 py-2 text-sm font-medium text-zinc-50 transition-colors hover:bg-teal-800 disabled:opacity-50 dark:bg-teal-400 dark:text-teal-950 dark:hover:bg-teal-300"
          >
            {saving ? "Saving..." : "Save"}
          </button>
          {message && (
            <span className="text-sm text-emerald-600 dark:text-emerald-400">{message}</span>
          )}
        </div>
      </div>

      <div className="mb-6 flex flex-col gap-4 rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
        <div>
          <h2 className="mb-1 text-base font-semibold text-zinc-900 dark:text-zinc-50">
            Independent screening
          </h2>
          <p className="text-sm text-zinc-600 dark:text-zinc-300">
            With independent screening on, every record needs the set number
            of opinions before the team outcome exists, and until then
            nobody sees anyone else&apos;s decision on it, anywhere.
            Agreement becomes the team decision; disagreement becomes a
            conflict any member can settle after discussion, with the
            settlement logged. Queues balance themselves: each reviewer sees
            what still needs an opinion they have not given, so with four
            reviewers and two opinions per record, each covers about half
            the stack. This is what lets the team write that records were
            screened independently by multiple reviewers.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
            Independent screening
          </span>
          <button
            onClick={() =>
              independent ? saveOpinions(1, 1) : saveOpinions(2, 2)
            }
            disabled={savingReq}
            role="switch"
            aria-checked={independent}
            className={`relative h-6 w-11 rounded-full transition-colors disabled:opacity-50 ${
              independent
                ? "bg-teal-700 dark:bg-teal-400"
                : "bg-zinc-300 dark:bg-zinc-700"
            }`}
          >
            <span
              className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all dark:bg-zinc-950 ${
                independent ? "left-[22px]" : "left-0.5"
              }`}
            />
          </button>
          <span className="text-xs text-zinc-500 dark:text-zinc-400">
            {independent
              ? "On: both stages default to 2 opinions; adjust per stage below."
              : "Off: classic single screening (1 opinion per record)."}
          </span>
        </div>
        {independent && (
          <div className="flex flex-wrap gap-6">
            <label className={labelCls}>
              Title/abstract: opinions per record
              <select
                value={reqTa}
                onChange={(e) => saveOpinions(Number(e.target.value), reqFt)}
                disabled={savingReq}
                className={inputCls}
              >
                {[1, 2, 3].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
            <label className={labelCls}>
              Full text: opinions per record
              <select
                value={reqFt}
                onChange={(e) => saveOpinions(reqTa, Number(e.target.value))}
                disabled={savingReq}
                className={inputCls}
              >
                {[1, 2, 3].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}
        {reqMsg && (
          <span className="text-sm text-emerald-600 dark:text-emerald-400">
            {reqMsg}
          </span>
        )}
      </div>

      <ApiKeysCard />

      {error && (
        <p className="rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
          {error}
        </p>
      )}
    </main>
  );
}
