"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import ApiKeysCard from "@/components/project/ApiKeysCard";
import TeamCard from "@/components/project/TeamCard";
import type { Project } from "@/lib/types";

export default function SettingsClient({
  project,
  userId,
}: {
  project: Project;
  userId: string;
}) {
  const [name, setName] = useState(project.name);
  // Owners manage settings; members see them read only.
  const [isOwner, setIsOwner] = useState(true);
  useEffect(() => {
    (async () => {
      const supabase = createClient();
      const { data } = await supabase
        .from("project_members")
        .select("role")
        .eq("project_id", project.id)
        .eq("user_id", userId)
        .maybeSingle();
       
      setIsOwner(data?.role === "owner");
    })();
  }, [project.id, userId]);
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

  async function save() {
    setSaving(true);
    setMessage(null);
    setError(null);
    const supabase = createClient();
    const { error: upErr } = await supabase
      .from("projects")
      .update({
        name: name.trim() || project.name,
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
      <h1 className="mb-6 font-serif text-2xl font-semibold text-zinc-900 dark:text-zinc-50">
        Project settings
      </h1>

      <div className="mb-6 flex flex-col gap-4 rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
        <p className="text-sm text-zinc-600 dark:text-zinc-300">
          The research objective and questions live on the project page. The
          search string and limits live on the Discovery page. The inclusion
          and exclusion criteria, the exclusion reasons, and the screening
          highlight keywords live in the screening room, next to where
          decisions get made.
        </p>
        {!isOwner && (
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            Owner only: project settings can be changed by project owners.
          </p>
        )}
        <label className={labelCls}>
          Name
          <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} disabled={!isOwner} />
        </label>
        <div className="flex items-center gap-3">
          <button
            onClick={save}
            disabled={saving || !isOwner}
            className="rounded-md bg-teal-700 px-5 py-2 text-sm font-medium text-zinc-50 transition-colors hover:bg-teal-800 disabled:opacity-50 dark:bg-teal-400 dark:text-teal-950 dark:hover:bg-teal-300"
          >
            {saving ? "Saving..." : "Save"}
          </button>
          {message && (
            <span className="text-sm text-emerald-600 dark:text-emerald-400">{message}</span>
          )}
        </div>
      </div>

      <TeamCard projectId={project.id} userId={userId} />

      <div className="mb-6 flex flex-col gap-4 rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
        <div>
          <h2 className="mb-1 font-serif text-base font-semibold text-zinc-900 dark:text-zinc-50">
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
            disabled={savingReq || !isOwner}
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
                disabled={savingReq || !isOwner}
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
                disabled={savingReq || !isOwner}
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
