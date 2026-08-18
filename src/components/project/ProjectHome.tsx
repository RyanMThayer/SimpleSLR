"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { outcomeOf } from "@/lib/outcomes";
import type { Project, ProjectMember } from "@/lib/types";

type MemberProgress = ProjectMember & {
  assigned: number;
  done: number;
  ftAssigned: number;
  ftDone: number;
};

export default function ProjectHome({
  project,
  userId,
}: {
  project: Project;
  userId: string;
}) {
  const [activeCount, setActiveCount] = useState(0);
  const [dupCount, setDupCount] = useState(0);
  const [unassigned, setUnassigned] = useState(0);
  const [members, setMembers] = useState<MemberProgress[]>([]);
  const [copied, setCopied] = useState(false);
  const [distributing, setDistributing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [ftEligible, setFtEligible] = useState(0);
  const [ftNotRetrieved, setFtNotRetrieved] = useState(0);
  const [ftUnassignedIds, setFtUnassignedIds] = useState<string[]>([]);
  const [distributingFt, setDistributingFt] = useState(false);
  const [editingRq, setEditingRq] = useState(false);
  const [objective, setObjective] = useState(project.research_objective ?? "");
  const [questions, setQuestions] = useState(project.research_question ?? "");
  const [savingRq, setSavingRq] = useState(false);

  const load = useCallback(async () => {
    const supabase = createClient();
    const [act, dup, unas, mem] = await Promise.all([
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
      supabase
        .from("records")
        .select("id", { count: "exact", head: true })
        .eq("project_id", project.id)
        .eq("status", "active")
        .is("assigned_to", null),
      supabase
        .from("project_members")
        .select("*, profiles(id, email, display_name)")
        .eq("project_id", project.id),
    ]);
    setActiveCount(act.count ?? 0);
    setDupCount(dup.count ?? 0);
    setUnassigned(unas.count ?? 0);

    // Full text eligibility: team level title/abstract includes.
    const taByRecord = new Map<string, { decision: string }[]>();
    for (let from = 0; ; from += 1000) {
      const { data } = await supabase
        .from("screening_decisions")
        .select("record_id, decision")
        .eq("project_id", project.id)
        .eq("stage", "title_abstract")
        .range(from, from + 999);
      (data ?? []).forEach((d) => {
        const list = taByRecord.get(d.record_id) ?? [];
        list.push(d);
        taByRecord.set(d.record_id, list);
      });
      if (!data || data.length < 1000) break;
    }
    type Slim = {
      id: string;
      ft_assigned_to: string | null;
      retrieval_status: string | null;
    };
    const activeSlim: Slim[] = [];
    for (let from = 0; ; from += 1000) {
      const { data } = await supabase
        .from("records")
        .select("id, ft_assigned_to, retrieval_status")
        .eq("project_id", project.id)
        .eq("status", "active")
        .range(from, from + 999);
      activeSlim.push(...((data ?? []) as Slim[]));
      if (!data || data.length < 1000) break;
    }
    const eligible = activeSlim.filter(
      (r) => outcomeOf(taByRecord.get(r.id) ?? []) === "included"
    );
    setFtEligible(eligible.length);
    setFtNotRetrieved(
      eligible.filter((r) => r.retrieval_status === "not_retrieved").length
    );
    setFtUnassignedIds(
      eligible
        .filter((r) => r.ft_assigned_to === null && r.retrieval_status === null)
        .map((r) => r.id)
    );
    const ftAssignedBy = new Map<string, number>();
    eligible.forEach((r) => {
      if (r.ft_assigned_to && r.retrieval_status === null) {
        ftAssignedBy.set(
          r.ft_assigned_to,
          (ftAssignedBy.get(r.ft_assigned_to) ?? 0) + 1
        );
      }
    });

    const memberRows = (mem.data ?? []) as ProjectMember[];
    const progress: MemberProgress[] = await Promise.all(
      memberRows.map(async (m) => {
        const [assigned, done, ftDone] = await Promise.all([
          supabase
            .from("records")
            .select("id", { count: "exact", head: true })
            .eq("project_id", project.id)
            .eq("status", "active")
            .eq("assigned_to", m.user_id),
          supabase
            .from("screening_decisions")
            .select("id", { count: "exact", head: true })
            .eq("project_id", project.id)
            .eq("stage", "title_abstract")
            .eq("decided_by", m.user_id),
          supabase
            .from("screening_decisions")
            .select("id", { count: "exact", head: true })
            .eq("project_id", project.id)
            .eq("stage", "full_text")
            .eq("decided_by", m.user_id),
        ]);
        return {
          ...m,
          assigned: assigned.count ?? 0,
          done: done.count ?? 0,
          ftAssigned: ftAssignedBy.get(m.user_id) ?? 0,
          ftDone: ftDone.count ?? 0,
        };
      })
    );
    setMembers(progress);
  }, [project.id]);

  useEffect(() => {
    // Fetch-on-mount: state updates happen after awaits inside load().
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  async function copyCode() {
    try {
      await navigator.clipboard.writeText(project.invite_code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setMessage(`Invite code: ${project.invite_code}`);
    }
  }

  async function distribute() {
    setDistributing(true);
    setMessage(null);
    const supabase = createClient();
    const { data: unassignedRecords, error } = await supabase
      .from("records")
      .select("id")
      .eq("project_id", project.id)
      .eq("status", "active")
      .is("assigned_to", null)
      .order("created_at");
    if (error || !unassignedRecords || members.length === 0) {
      setMessage(error?.message ?? "Nothing to distribute.");
      setDistributing(false);
      return;
    }
    const buckets = new Map<string, string[]>();
    members.forEach((m) => buckets.set(m.user_id, []));
    unassignedRecords.forEach((r, i) => {
      const m = members[i % members.length];
      buckets.get(m.user_id)!.push(r.id);
    });
    for (const [uid, ids] of buckets) {
      for (let i = 0; i < ids.length; i += 200) {
        const slice = ids.slice(i, i + 200);
        const { error: upErr } = await supabase
          .from("records")
          .update({ assigned_to: uid })
          .in("id", slice);
        if (upErr) {
          setMessage(upErr.message);
          setDistributing(false);
          return;
        }
      }
    }
    setMessage(
      `Distributed ${unassignedRecords.length} records among ${members.length} member(s).`
    );
    setDistributing(false);
    load();
  }

  async function distributeFt() {
    if (ftUnassignedIds.length === 0 || members.length === 0) return;
    setDistributingFt(true);
    setMessage(null);
    const supabase = createClient();
    const buckets = new Map<string, string[]>();
    members.forEach((m) => buckets.set(m.user_id, []));
    ftUnassignedIds.forEach((id, i) => {
      const m = members[i % members.length];
      buckets.get(m.user_id)!.push(id);
    });
    for (const [uid, ids] of buckets) {
      for (let i = 0; i < ids.length; i += 200) {
        const { error: upErr } = await supabase
          .from("records")
          .update({ ft_assigned_to: uid })
          .in("id", ids.slice(i, i + 200));
        if (upErr) {
          setMessage(upErr.message);
          setDistributingFt(false);
          return;
        }
      }
    }
    setMessage(
      `Distributed ${ftUnassignedIds.length} full text record(s) among ${members.length} member(s).`
    );
    setDistributingFt(false);
    load();
  }

  async function saveResearch() {
    setSavingRq(true);
    const supabase = createClient();
    const { error } = await supabase
      .from("projects")
      .update({
        research_objective: objective.trim() || null,
        research_question: questions.trim() || null,
      })
      .eq("id", project.id);
    setSavingRq(false);
    if (error) {
      setMessage(error.message);
      return;
    }
    setEditingRq(false);
  }

  const tile =
    "rounded-xl border border-zinc-200 bg-white p-5 transition-colors hover:border-zinc-400 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-zinc-600";
  const rqInput =
    "w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50";

  return (
    <main className="mx-auto w-full max-w-4xl flex-1 px-6 py-8">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-50">
            {project.name}
          </h1>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            {activeCount} active records · {dupCount} duplicates
            {unassigned > 0 && <> · {unassigned} unassigned</>}
          </p>
        </div>
        <button
          onClick={copyCode}
          className="rounded-full border border-zinc-300 px-4 py-2 text-sm text-zinc-700 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
          title="Teammates join with this code on their dashboard"
        >
          {copied ? "Copied!" : `Invite code: ${project.invite_code}`}
        </button>
      </div>

      <section className="mb-8 rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-400">
            Research objective and questions
          </h2>
          {!editingRq ? (
            <button
              onClick={() => setEditingRq(true)}
              className="text-xs text-zinc-500 underline underline-offset-2 hover:text-zinc-800 dark:hover:text-zinc-200"
            >
              Edit
            </button>
          ) : (
            <div className="flex gap-3">
              <button
                onClick={saveResearch}
                disabled={savingRq}
                className="text-xs font-medium text-emerald-600 underline underline-offset-2"
              >
                {savingRq ? "Saving..." : "Save"}
              </button>
              <button
                onClick={() => {
                  setEditingRq(false);
                  setObjective(project.research_objective ?? "");
                  setQuestions(project.research_question ?? "");
                }}
                className="text-xs text-zinc-400 underline underline-offset-2"
              >
                Cancel
              </button>
            </div>
          )}
        </div>
        {editingRq ? (
          <div className="flex flex-col gap-3">
            <label className="flex flex-col gap-1 text-sm font-medium text-zinc-700 dark:text-zinc-300">
              Research objective
              <textarea
                className={`${rqInput} min-h-16`}
                placeholder="What this review sets out to establish"
                value={objective}
                onChange={(e) => setObjective(e.target.value)}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm font-medium text-zinc-700 dark:text-zinc-300">
              Research questions (one per line)
              <textarea
                className={`${rqInput} min-h-24`}
                placeholder={"RQ1: ...\nRQ2: ..."}
                value={questions}
                onChange={(e) => setQuestions(e.target.value)}
              />
            </label>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {objective ? (
              <p className="text-zinc-800 dark:text-zinc-200">{objective}</p>
            ) : (
              <p className="text-sm italic text-zinc-400">
                No research objective yet. It anchors the search string and the
                criteria, so add it early.
              </p>
            )}
            {questions ? (
              <div className="flex flex-col gap-1">
                {questions.split("\n").filter((l) => l.trim()).map((l, i) => (
                  <p key={i} className="text-sm text-zinc-700 dark:text-zinc-300">
                    {l}
                  </p>
                ))}
              </div>
            ) : (
              <p className="text-sm italic text-zinc-400">
                No research questions yet.
              </p>
            )}
          </div>
        )}
      </section>

      <div className="mb-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Link href={`/projects/${project.id}/discovery`} className={tile}>
          <h2 className="font-semibold text-zinc-900 dark:text-zinc-50">Discovery</h2>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            Search string, databases, import
          </p>
        </Link>
        <Link href={`/projects/${project.id}/screen`} className={tile}>
          <h2 className="font-semibold text-zinc-900 dark:text-zinc-50">Screen</h2>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            Title/abstract and full text stages
          </p>
        </Link>
        <Link href={`/projects/${project.id}/records`} className={tile}>
          <h2 className="font-semibold text-zinc-900 dark:text-zinc-50">Records</h2>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            Browse, search, and audit
          </p>
        </Link>
        <Link href={`/projects/${project.id}/duplicates`} className={tile}>
          <h2 className="font-semibold text-zinc-900 dark:text-zinc-50">Duplicates</h2>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            Review near match pairs
          </p>
        </Link>
        <Link href={`/projects/${project.id}/snowball`} className={tile}>
          <h2 className="font-semibold text-zinc-900 dark:text-zinc-50">Snowball</h2>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            Backward and forward citation search
          </p>
        </Link>
        <Link href={`/projects/${project.id}/concepts`} className={tile}>
          <h2 className="font-semibold text-zinc-900 dark:text-zinc-50">Concepts</h2>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            Webster and Watson concept matrix
          </p>
        </Link>
        <Link href={`/projects/${project.id}/prisma`} className={tile}>
          <h2 className="font-semibold text-zinc-900 dark:text-zinc-50">
            PRISMA and exports
          </h2>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            Flow diagram, RIS, CSV, backup
          </p>
        </Link>
        <Link href={`/projects/${project.id}/settings`} className={tile}>
          <h2 className="font-semibold text-zinc-900 dark:text-zinc-50">Settings</h2>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            Name and highlight keywords
          </p>
        </Link>
      </div>

      <section className="mb-8">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">
            Title and abstract progress
          </h2>
          <button
            onClick={distribute}
            disabled={distributing || unassigned === 0}
            className="rounded-full bg-zinc-900 px-4 py-2 text-sm font-medium text-zinc-50 transition-colors hover:bg-zinc-700 disabled:opacity-40 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-300"
            title="Split all unassigned records evenly among team members"
          >
            {distributing ? "Distributing..." : "Distribute unassigned"}
          </button>
        </div>
        {message && (
          <p className="mb-3 text-sm text-zinc-600 dark:text-zinc-400">{message}</p>
        )}
        <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
          {members.map((m) => {
            const pct =
              m.assigned > 0
                ? Math.min(100, Math.round((m.done / m.assigned) * 100))
                : 0;
            return (
              <Link
                key={m.user_id}
                href={`/projects/${project.id}/screen`}
                title="Open the screening room"
                className="flex items-center gap-4 border-b border-zinc-100 px-5 py-3 transition-colors last:border-b-0 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-800/50"
              >
                <span className="w-48 truncate text-sm font-medium text-zinc-900 dark:text-zinc-50">
                  {m.profiles?.display_name ?? m.profiles?.email ?? "member"}
                  {m.user_id === userId && " (you)"}
                  {m.role === "owner" && (
                    <span className="ml-1 text-xs text-zinc-400">owner</span>
                  )}
                </span>
                <div className="h-2 flex-1 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
                  <div
                    className="h-full rounded-full bg-emerald-500"
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <span className="w-28 text-right text-sm text-zinc-500 dark:text-zinc-400">
                  {m.done} / {m.assigned}
                </span>
              </Link>
            );
          })}
          {members.length === 0 && (
            <p className="px-5 py-4 text-sm text-zinc-500 dark:text-zinc-400">
              Loading members...
            </p>
          )}
        </div>
      </section>

      <section className="mb-8">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">
            Full text progress
          </h2>
          <button
            onClick={distributeFt}
            disabled={distributingFt || ftUnassignedIds.length === 0}
            className="rounded-full bg-zinc-900 px-4 py-2 text-sm font-medium text-zinc-50 transition-colors hover:bg-zinc-700 disabled:opacity-40 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-300"
            title="Split the unassigned full text records evenly among team members"
          >
            {distributingFt ? "Distributing..." : "Distribute full text"}
          </button>
        </div>
        <p className="mb-3 text-sm text-zinc-500 dark:text-zinc-400">
          {ftEligible} record(s) included at title/abstract ·{" "}
          {ftUnassignedIds.length} unassigned · {ftNotRetrieved} not
          retrievable
        </p>
        <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
          {ftEligible === 0 ? (
            <p className="px-5 py-4 text-sm text-zinc-500 dark:text-zinc-400">
              Nothing has reached full text yet. Records arrive here once the
              team includes them at the title and abstract stage.
            </p>
          ) : (
            members.map((m) => {
              const pct =
                m.ftAssigned > 0
                  ? Math.min(100, Math.round((m.ftDone / m.ftAssigned) * 100))
                  : 0;
              return (
                <Link
                  key={m.user_id}
                  href={`/projects/${project.id}/screen?stage=full_text`}
                  title="Open the screening room (Full text tab)"
                  className="flex items-center gap-4 border-b border-zinc-100 px-5 py-3 transition-colors last:border-b-0 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-800/50"
                >
                  <span className="w-48 truncate text-sm font-medium text-zinc-900 dark:text-zinc-50">
                    {m.profiles?.display_name ?? m.profiles?.email ?? "member"}
                    {m.user_id === userId && " (you)"}
                  </span>
                  <div className="h-2 flex-1 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
                    <div
                      className="h-full rounded-full bg-sky-500"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <span className="w-28 text-right text-sm text-zinc-500 dark:text-zinc-400">
                    {m.ftDone} / {m.ftAssigned}
                  </span>
                </Link>
              );
            })
          )}
        </div>
      </section>

    </main>
  );
}
