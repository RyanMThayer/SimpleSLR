"use client";

import { Fragment, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { requiredFor, settledOutcome } from "@/lib/outcomes";
import { fetchResolutions, resKey } from "@/lib/resolutions";
import type { Project, ProjectMember } from "@/lib/types";

/**
 * Research questions are stored one per line, usually typed as
 * "RQ1: ..."; the chip renders separately from the text, so a typed
 * label is lifted out and lines without one get numbered in order.
 */
function splitRq(line: string, i: number): { label: string; text: string } {
  const m = line.match(/^\s*(RQ\s*\d+)\s*[:.\-]\s*(.+)$/i);
  if (m) {
    return { label: m[1].replace(/\s+/g, "").toUpperCase(), text: m[2] };
  }
  return { label: `RQ${i + 1}`, text: line.trim() };
}

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

    // Full text eligibility: team level title/abstract includes. The
    // per member sets track who decided what, so progress counts only
    // decisions on records that still exist and are still active
    // (decisions on later deduplicated records must not inflate "done").
    const taByRecord = new Map<string, { decision: string }[]>();
    const taDecidedBy = new Map<string, Set<string>>();
    for (let from = 0; ; from += 1000) {
      const { data } = await supabase
        .from("screening_decisions")
        .select("record_id, decision, decided_by")
        .eq("project_id", project.id)
        .eq("stage", "title_abstract")
        .range(from, from + 999);
      (data ?? []).forEach((d) => {
        const list = taByRecord.get(d.record_id) ?? [];
        list.push(d);
        taByRecord.set(d.record_id, list);
        const set = taDecidedBy.get(d.decided_by) ?? new Set<string>();
        set.add(d.record_id);
        taDecidedBy.set(d.decided_by, set);
      });
      if (!data || data.length < 1000) break;
    }
    const ftDecidedBy = new Map<string, Set<string>>();
    const ftCountByRecord = new Map<string, number>();
    for (let from = 0; ; from += 1000) {
      const { data } = await supabase
        .from("screening_decisions")
        .select("record_id, decided_by")
        .eq("project_id", project.id)
        .eq("stage", "full_text")
        .range(from, from + 999);
      (data ?? []).forEach((d) => {
        const set = ftDecidedBy.get(d.decided_by) ?? new Set<string>();
        set.add(d.record_id);
        ftDecidedBy.set(d.decided_by, set);
        ftCountByRecord.set(
          d.record_id,
          (ftCountByRecord.get(d.record_id) ?? 0) + 1
        );
      });
      if (!data || data.length < 1000) break;
    }
    const resMap = await fetchResolutions(supabase, project.id);
    const taReq = requiredFor(project, "title_abstract");
    const ftReq = requiredFor(project, "full_text");
    type Slim = {
      id: string;
      assigned_to: string | null;
      ft_assigned_to: string | null;
      retrieval_status: string | null;
    };
    const activeSlim: Slim[] = [];
    for (let from = 0; ; from += 1000) {
      const { data } = await supabase
        .from("records")
        .select("id, assigned_to, ft_assigned_to, retrieval_status")
        .eq("project_id", project.id)
        .eq("status", "active")
        .range(from, from + 999);
      activeSlim.push(...((data ?? []) as Slim[]));
      if (!data || data.length < 1000) break;
    }
    const eligible = activeSlim.filter(
      (r) =>
        settledOutcome(
          taByRecord.get(r.id) ?? [],
          resMap.get(resKey("title_abstract", r.id)),
          taReq
        ) === "included"
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

    const memberRows = (mem.data ?? []) as ProjectMember[];
    const progress: MemberProgress[] = memberRows.map((m) => {
      // Only decisions on records that are still active count, and pool
      // screened records (decided while unassigned) join the member's
      // total, so done can never exceed the total.
      const taSet = taDecidedBy.get(m.user_id) ?? new Set<string>();
      // A record assigned to this member but decided by a helping
      // teammate is done for the team and leaves this member's
      // personal total, so a finished stage reads finished.
      const myAssigned = activeSlim.filter(
        (r) =>
          r.assigned_to === m.user_id &&
          (taSet.has(r.id) || (taByRecord.get(r.id)?.length ?? 0) === 0)
      );
      const myDecidedActive = activeSlim.filter((r) => taSet.has(r.id));
      // Independent screening (quota above 1): assignment pools do not
      // apply; a member's total is what they decided plus what still
      // needs an opinion they have not given.
      const taUnion =
        taReq > 1
          ? new Set([
              ...myDecidedActive.map((r) => r.id),
              ...activeSlim
                .filter(
                  (r) =>
                    !taSet.has(r.id) &&
                    (taByRecord.get(r.id)?.length ?? 0) < taReq &&
                    !resMap.has(resKey("title_abstract", r.id))
                )
                .map((r) => r.id),
            ])
          : new Set([
              ...myAssigned.map((r) => r.id),
              ...myDecidedActive.map((r) => r.id),
            ]);

      const ftSet = ftDecidedBy.get(m.user_id) ?? new Set<string>();
      const retrievable = eligible.filter((r) => r.retrieval_status === null);
      const myFtAssigned = retrievable.filter(
        (r) =>
          r.ft_assigned_to === m.user_id &&
          (ftSet.has(r.id) || (ftCountByRecord.get(r.id) ?? 0) === 0)
      );
      const myFtDecided = retrievable.filter((r) => ftSet.has(r.id));
      const ftUnion =
        ftReq > 1
          ? new Set([
              ...myFtDecided.map((r) => r.id),
              ...retrievable
                .filter(
                  (r) =>
                    !ftSet.has(r.id) &&
                    (ftCountByRecord.get(r.id) ?? 0) < ftReq &&
                    !resMap.has(resKey("full_text", r.id))
                )
                .map((r) => r.id),
            ])
          : new Set([
              ...myFtAssigned.map((r) => r.id),
              ...myFtDecided.map((r) => r.id),
            ]);

      return {
        ...m,
        assigned: taUnion.size,
        done: myDecidedActive.length,
        ftAssigned: ftUnion.size,
        ftDone: myFtDecided.length,
      };
    });
    setMembers(progress);
  }, [project]);

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
    "relative flex flex-col rounded-xl border border-zinc-200 bg-white p-4 transition-colors hover:border-zinc-400 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-zinc-600";
  const tileTitle = "font-serif font-semibold text-zinc-900 dark:text-zinc-50";
  const tileDesc = "mt-0.5 flex-1 text-sm text-zinc-600 dark:text-zinc-400";
  const tileStat =
    "mt-3 border-t border-zinc-100 pt-2 font-mono text-[11px] tabular-nums text-zinc-500 dark:border-zinc-800 dark:text-zinc-400";
  const tileNum =
    "absolute top-3.5 right-4 font-mono text-[11px] text-zinc-400 dark:text-zinc-500";
  const rqInput =
    "w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 outline-none focus:border-teal-600 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50";

  return (
    <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-8">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-serif text-[26px] font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
            {project.name}
          </h1>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            {activeCount} active records · {dupCount} duplicates
            {unassigned > 0 && <> · {unassigned} unassigned</>}
          </p>
        </div>
        <button
          onClick={copyCode}
          className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 font-mono text-xs text-zinc-700 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
          title="Teammates join with this code on their dashboard"
        >
          {copied ? "Copied!" : `invite ${project.invite_code}`}
        </button>
      </div>

      <section className="mb-7 overflow-hidden rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
        <div className="flex items-center justify-between border-b border-zinc-200 bg-zinc-100/70 px-5 py-2 dark:border-zinc-800 dark:bg-zinc-800/40">
          <h2 className="text-[11px] font-semibold uppercase tracking-widest text-zinc-500 dark:text-zinc-400">
            Research objective and questions
          </h2>
          {!editingRq ? (
            members.find((m) => m.user_id === userId)?.role === "owner" ? (
              <button
                onClick={() => setEditingRq(true)}
                className="text-xs text-zinc-500 underline underline-offset-2 hover:text-zinc-800 dark:hover:text-zinc-200"
              >
                Edit
              </button>
            ) : (
              <span
                className="text-xs text-zinc-400 dark:text-zinc-500"
                title="Project owners edit the research objective and questions"
              >
                owner only
              </span>
            )
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
                className="text-xs text-zinc-500 dark:text-zinc-400 underline underline-offset-2"
              >
                Cancel
              </button>
            </div>
          )}
        </div>
        {editingRq ? (
          <div className="flex flex-col gap-3 px-5 py-4">
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
          <div className="flex flex-col gap-3 px-5 py-4">
            {objective ? (
              <p className="font-serif text-[15.5px] leading-relaxed text-zinc-800 dark:text-zinc-200">
                {objective}
              </p>
            ) : (
              <p className="text-sm italic text-zinc-500 dark:text-zinc-400">
                No research objective yet. It anchors the search string and the
                criteria, so add it early.
              </p>
            )}
            {questions ? (
              <div className="grid grid-cols-[44px_1fr] gap-y-1.5">
                {questions.split("\n").filter((l) => l.trim()).map((l, i) => {
                  const { label, text } = splitRq(l, i);
                  return (
                    <Fragment key={i}>
                      <b className="pt-0.5 font-mono text-[11.5px] font-medium text-teal-700 dark:text-teal-400">
                        {label}
                      </b>
                      <span className="font-serif text-[14.5px] leading-normal text-zinc-700 dark:text-zinc-300">
                        {text}
                      </span>
                    </Fragment>
                  );
                })}
              </div>
            ) : (
              <p className="text-sm italic text-zinc-500 dark:text-zinc-400">
                No research questions yet.
              </p>
            )}
          </div>
        )}
      </section>

      <p className="mb-2.5 text-[11px] font-semibold uppercase tracking-widest text-zinc-500 dark:text-zinc-400">
        The review
      </p>
      <div className="mb-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Link href={`/projects/${project.id}/discovery`} className={tile}>
          <span className={tileNum}>1</span>
          <h2 className={tileTitle}>Discovery</h2>
          <p className={tileDesc}>Search string, databases, import.</p>
          <div className={tileStat}>{activeCount} records</div>
        </Link>
        <Link href={`/projects/${project.id}/screen`} className={tile}>
          <span className={tileNum}>2</span>
          <h2 className={tileTitle}>Screen</h2>
          <p className={tileDesc}>Title/abstract and full text stages.</p>
        </Link>
        <Link href={`/projects/${project.id}/read`} className={tile}>
          <span className={tileNum}>3</span>
          <h2 className={tileTitle}>Synthesize</h2>
          <p className={tileDesc}>Reading room and concept matrix.</p>
        </Link>
        <Link href={`/projects/${project.id}/prisma`} className={tile}>
          <span className={tileNum}>4</span>
          <h2 className={tileTitle}>Report</h2>
          <p className={tileDesc}>PRISMA diagram, written methods, exports.</p>
        </Link>
      </div>
      <div className="mb-8 grid gap-3 sm:grid-cols-3">
        <Link href={`/projects/${project.id}/snowball`} className={tile}>
          <h2 className={tileTitle}>Snowball</h2>
          <p className={tileDesc}>Backward and forward citation search.</p>
        </Link>
        <Link href={`/projects/${project.id}/records`} className={tile}>
          <h2 className={tileTitle}>Records</h2>
          <p className={tileDesc}>The corpus: browse, search, audit, duplicates.</p>
          {dupCount > 0 && (
            <div className={tileStat}>
              {activeCount} live · {dupCount} duplicates
            </div>
          )}
        </Link>
        <Link href={`/projects/${project.id}/settings`} className={tile}>
          <h2 className={tileTitle}>Project Settings</h2>
          <p className={tileDesc}>Team, screening quotas, API keys.</p>
        </Link>
      </div>

      <section className="mb-8">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-serif text-lg font-semibold text-zinc-900 dark:text-zinc-50">
            Title and abstract progress
          </h2>
          {requiredFor(project, "title_abstract") <= 1 ? (
            <button
              onClick={distribute}
              disabled={distributing || unassigned === 0}
              className="rounded-md bg-teal-700 px-4 py-2 text-sm font-medium text-zinc-50 transition-colors hover:bg-teal-800 disabled:opacity-40 dark:bg-teal-400 dark:text-teal-950 dark:hover:bg-teal-300"
              title="Split all unassigned records evenly among team members"
            >
              {distributing ? "Distributing..." : "Distribute unassigned"}
            </button>
          ) : (
            <span
              className="text-sm text-zinc-500 dark:text-zinc-400"
              title="Every record needs its quota of independent opinions; queues balance themselves, so there is nothing to hand out"
            >
              Independent screening:{" "}
              {requiredFor(project, "title_abstract")} opinions per record
            </span>
          )}
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
                    <span className="ml-1 text-xs text-zinc-500 dark:text-zinc-400">owner</span>
                  )}
                </span>
                <div className="h-2 flex-1 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
                  <div
                    className="h-full rounded-full bg-teal-600"
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <span className="w-28 text-right text-sm tabular-nums text-zinc-600 dark:text-zinc-400">
                  {m.done} / {m.assigned}
                </span>
              </Link>
            );
          })}
          {members.length === 0 && (
            <p className="px-5 py-4 text-sm text-zinc-600 dark:text-zinc-400">
              Loading members...
            </p>
          )}
        </div>
      </section>

      <section className="mb-8">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-serif text-lg font-semibold text-zinc-900 dark:text-zinc-50">
            Full text progress
          </h2>
          {requiredFor(project, "full_text") <= 1 ? (
            <button
              onClick={distributeFt}
              disabled={distributingFt || ftUnassignedIds.length === 0}
              className="rounded-md bg-teal-700 px-4 py-2 text-sm font-medium text-zinc-50 transition-colors hover:bg-teal-800 disabled:opacity-40 dark:bg-teal-400 dark:text-teal-950 dark:hover:bg-teal-300"
              title="Split the unassigned full text records evenly among team members"
            >
              {distributingFt ? "Distributing..." : "Distribute full text"}
            </button>
          ) : (
            <span
              className="text-sm text-zinc-500 dark:text-zinc-400"
              title="Every record needs its quota of independent opinions; queues balance themselves, so there is nothing to hand out"
            >
              Independent screening: {requiredFor(project, "full_text")}{" "}
              opinions per record
            </span>
          )}
        </div>
        <p className="mb-3 text-sm text-zinc-600 dark:text-zinc-400">
          {ftEligible} record(s) included at title/abstract ·{" "}
          {ftUnassignedIds.length} unassigned · {ftNotRetrieved} not
          retrievable
        </p>
        <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
          {ftEligible === 0 ? (
            <p className="px-5 py-4 text-sm text-zinc-600 dark:text-zinc-400">
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
                  <span className="w-28 text-right text-sm tabular-nums text-zinc-600 dark:text-zinc-400">
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
