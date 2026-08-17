"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import type { Project, ProjectMember } from "@/lib/types";

type MemberProgress = ProjectMember & {
  assigned: number;
  done: number;
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

    const memberRows = (mem.data ?? []) as ProjectMember[];
    const progress: MemberProgress[] = await Promise.all(
      memberRows.map(async (m) => {
        const [assigned, done] = await Promise.all([
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
        ]);
        return { ...m, assigned: assigned.count ?? 0, done: done.count ?? 0 };
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

  const tile =
    "rounded-xl border border-zinc-200 bg-white p-5 transition-colors hover:border-zinc-400 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-zinc-600";

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

      <div className="mb-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Link href={`/projects/${project.id}/import`} className={tile}>
          <h2 className="font-semibold text-zinc-900 dark:text-zinc-50">Import</h2>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            RIS or CSV from Scopus, WoS, IEEE
          </p>
        </Link>
        <Link href={`/projects/${project.id}/screen`} className={tile}>
          <h2 className="font-semibold text-zinc-900 dark:text-zinc-50">Screen</h2>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            Title and abstract, keyboard first
          </p>
        </Link>
        <Link href={`/projects/${project.id}/records`} className={tile}>
          <h2 className="font-semibold text-zinc-900 dark:text-zinc-50">Records</h2>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            Browse, search, and audit
          </p>
        </Link>
        <Link href={`/projects/${project.id}/settings`} className={tile}>
          <h2 className="font-semibold text-zinc-900 dark:text-zinc-50">Settings</h2>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            Criteria, keywords, reasons
          </p>
        </Link>
      </div>

      <section className="mb-8">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">
            Team progress
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
              <div
                key={m.user_id}
                className="flex items-center gap-4 border-b border-zinc-100 px-5 py-3 last:border-b-0 dark:border-zinc-800"
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
              </div>
            );
          })}
          {members.length === 0 && (
            <p className="px-5 py-4 text-sm text-zinc-500 dark:text-zinc-400">
              Loading members...
            </p>
          )}
        </div>
      </section>

      {project.research_question && (
        <section className="rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
          <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-zinc-400">
            Research question
          </h2>
          <p className="text-zinc-800 dark:text-zinc-200">
            {project.research_question}
          </p>
        </section>
      )}
    </main>
  );
}
