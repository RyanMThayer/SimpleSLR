"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import type {
  Decision,
  ExclusionReason,
  Project,
  RecordRow,
} from "@/lib/types";

const STAGE = "title_abstract" as const;
const QUEUE_PAGE = 500;

function escapeRegExp(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** How many records assigned to this user remain undecided at this stage. */
async function remainingAssignedCount(
  projectId: string,
  uid: string,
  decided: Set<string>
) {
  const supabase = createClient();
  let remaining = 0;
  for (let from = 0; ; from += 1000) {
    const { data } = await supabase
      .from("records")
      .select("id")
      .eq("project_id", projectId)
      .eq("status", "active")
      .eq("assigned_to", uid)
      .range(from, from + 999);
    (data ?? []).forEach((r) => {
      if (!decided.has(r.id)) remaining++;
    });
    if (!data || data.length < 1000) break;
  }
  return remaining;
}

function Highlighted({
  text,
  include,
  exclude,
}: {
  text: string;
  include: string[];
  exclude: string[];
}) {
  const parts = useMemo(() => {
    const terms = [
      ...include.filter(Boolean).map((t) => ({ t, kind: "inc" as const })),
      ...exclude.filter(Boolean).map((t) => ({ t, kind: "exc" as const })),
    ];
    if (terms.length === 0) return [{ text, kind: null as null | "inc" | "exc" }];
    const pattern = new RegExp(
      `(${terms.map((x) => escapeRegExp(x.t)).join("|")})`,
      "gi"
    );
    const incSet = new Set(include.map((t) => t.toLowerCase()));
    return text.split(pattern).map((seg) => {
      const lower = seg.toLowerCase();
      const isTerm = terms.some((x) => x.t.toLowerCase() === lower);
      if (!isTerm) return { text: seg, kind: null as null | "inc" | "exc" };
      return {
        text: seg,
        kind: incSet.has(lower) ? ("inc" as const) : ("exc" as const),
      };
    });
  }, [text, include, exclude]);

  return (
    <>
      {parts.map((p, i) =>
        p.kind === null ? (
          <span key={i}>{p.text}</span>
        ) : (
          <mark
            key={i}
            className={
              p.kind === "inc"
                ? "rounded bg-emerald-200 px-0.5 text-emerald-950 dark:bg-emerald-800 dark:text-emerald-50"
                : "rounded bg-red-200 px-0.5 text-red-950 dark:bg-red-800 dark:text-red-50"
            }
          >
            {p.text}
          </mark>
        )
      )}
    </>
  );
}

export default function ScreenClient({
  project,
  userId,
}: {
  project: Project;
  userId: string;
}) {
  const [queue, setQueue] = useState<RecordRow[] | null>(null);
  const [reasons, setReasons] = useState<ExclusionReason[]>([]);
  const [mineTotal, setMineTotal] = useState(0);
  const [mineDone, setMineDone] = useState(0);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [canUndo, setCanUndo] = useState(false);
  const undoStack = useRef<RecordRow[]>([]);

  const load = useCallback(async () => {
    const supabase = createClient();

    const { data: reasonRows } = await supabase
      .from("exclusion_reasons")
      .select("*")
      .eq("project_id", project.id)
      .order("position");
    setReasons((reasonRows ?? []) as ExclusionReason[]);

    // Which records has this user already decided at this stage?
    const decided = new Set<string>();
    for (let from = 0; ; from += 1000) {
      const { data, error: dErr } = await supabase
        .from("screening_decisions")
        .select("record_id")
        .eq("project_id", project.id)
        .eq("stage", STAGE)
        .eq("decided_by", userId)
        .range(from, from + 999);
      if (dErr) {
        setError(dErr.message);
        return;
      }
      (data ?? []).forEach((d) => decided.add(d.record_id));
      if (!data || data.length < 1000) break;
    }

    // Queue mode: records assigned to me if any exist, otherwise the
    // unassigned pool.
    const { count: assignedCount } = await supabase
      .from("records")
      .select("id", { count: "exact", head: true })
      .eq("project_id", project.id)
      .eq("status", "active")
      .eq("assigned_to", userId);
    const useAssigned = (assignedCount ?? 0) > 0;

    let query = supabase
      .from("records")
      .select("*")
      .eq("project_id", project.id)
      .eq("status", "active")
      .order("created_at")
      .limit(QUEUE_PAGE);
    query = useAssigned
      ? query.eq("assigned_to", userId)
      : query.is("assigned_to", null);

    const { data: recordRows, error: rErr } = await query;
    if (rErr) {
      setError(rErr.message);
      return;
    }
    const all = (recordRows ?? []) as RecordRow[];
    const remaining = all.filter((r) => !decided.has(r.id));

    if (useAssigned) {
      setMineTotal(assignedCount ?? 0);
      const rem = await remainingAssignedCount(project.id, userId, decided);
      setMineDone(Math.max(0, (assignedCount ?? 0) - rem));
    } else {
      const { count: poolCount } = await supabase
        .from("records")
        .select("id", { count: "exact", head: true })
        .eq("project_id", project.id)
        .eq("status", "active")
        .is("assigned_to", null);
      setMineTotal(poolCount ?? 0);
      setMineDone(decided.size);
    }
    setError(null);
    setQueue(remaining);
  }, [project.id, userId]);

  useEffect(() => {
    // Fetch-on-mount: state updates happen after awaits inside load().
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  const current = queue?.[0] ?? null;

  const decide = useCallback(
    async (decision: Decision, reasonId: string | null = null) => {
      if (!current || saving) return;
      setSaving(true);
      setPickerOpen(false);
      const supabase = createClient();
      const { error: insErr } = await supabase.from("screening_decisions").upsert(
        {
          project_id: project.id,
          record_id: current.id,
          stage: STAGE,
          decision,
          reason_id: reasonId,
          decided_by: userId,
        },
        { onConflict: "record_id,stage,decided_by" }
      );
      setSaving(false);
      if (insErr) {
        setError(insErr.message);
        return;
      }
      undoStack.current.push(current);
      setCanUndo(true);
      const willBeEmpty = (queue?.length ?? 0) <= 1;
      setQueue((q) => (q ? q.slice(1) : q));
      setMineDone((d) => d + 1);
      // The queue loads in pages; when a page is exhausted, fetch the next.
      if (willBeEmpty) load();
    },
    [current, saving, project.id, userId, queue, load]
  );

  const undo = useCallback(async () => {
    const last = undoStack.current.pop();
    if (!last) return;
    const supabase = createClient();
    const { error: delErr } = await supabase
      .from("screening_decisions")
      .delete()
      .eq("record_id", last.id)
      .eq("stage", STAGE)
      .eq("decided_by", userId);
    if (delErr) {
      setError(delErr.message);
      return;
    }
    setQueue((q) => (q ? [last, ...q] : [last]));
    setMineDone((d) => Math.max(0, d - 1));
    setCanUndo(undoStack.current.length > 0);
  }, [userId]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") return;

      if (pickerOpen) {
        if (e.key === "Escape") {
          setPickerOpen(false);
        } else if (e.key === "Enter") {
          decide("exclude", null);
        } else if (/^[1-9]$/.test(e.key)) {
          const idx = parseInt(e.key, 10) - 1;
          if (idx < reasons.length) decide("exclude", reasons[idx].id);
        }
        e.preventDefault();
        return;
      }

      const k = e.key.toLowerCase();
      if (k === "i") {
        decide("include");
      } else if (k === "e") {
        if (reasons.length > 0) setPickerOpen(true);
        else decide("exclude");
      } else if (k === "m") {
        decide("maybe");
      } else if (k === "u") {
        undo();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pickerOpen, reasons, decide, undo]);

  const pct = mineTotal > 0 ? Math.round((mineDone / mineTotal) * 100) : 0;

  const btn =
    "rounded-full px-5 py-2.5 text-sm font-medium transition-colors disabled:opacity-50";

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col px-6 py-6">
      <div className="mb-4">
        <div className="mb-1 flex items-center justify-between text-sm text-zinc-500 dark:text-zinc-400">
          <span>
            Title and abstract screening · {mineDone} / {mineTotal} done ({pct}%)
          </span>
          <span className="hidden sm:inline">
            Keys: I include · E exclude · M maybe · U undo
          </span>
        </div>
        <div className="h-2 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
          <div
            className="h-full rounded-full bg-emerald-500 transition-all"
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>

      {error && (
        <p className="mb-4 rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
          {error}
        </p>
      )}

      {queue === null ? (
        <p className="text-zinc-500 dark:text-zinc-400">Loading your queue...</p>
      ) : current === null ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
          <h2 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-50">
            Queue empty. Nice work.
          </h2>
          <p className="max-w-md text-zinc-600 dark:text-zinc-400">
            You have screened everything currently assigned to you. Import more
            records, ask the owner to distribute unassigned ones, or review the
            results in the records table.
          </p>
          <div className="flex gap-3">
            <Link
              href={`/projects/${project.id}`}
              className={`${btn} bg-zinc-900 text-zinc-50 hover:bg-zinc-700 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-300`}
            >
              Back to project
            </Link>
            <Link
              href={`/projects/${project.id}/records`}
              className={`${btn} border border-zinc-300 text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800`}
            >
              Records table
            </Link>
          </div>
        </div>
      ) : (
        <div className="flex flex-1 flex-col">
          <article className="mb-5 flex-1 overflow-y-auto rounded-xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
            <h2 className="mb-2 text-xl font-semibold leading-snug text-zinc-900 dark:text-zinc-50">
              <Highlighted
                text={current.title}
                include={project.include_keywords}
                exclude={project.exclude_keywords}
              />
            </h2>
            <p className="mb-4 text-sm text-zinc-500 dark:text-zinc-400">
              {[current.authors, current.year, current.venue, current.source_label]
                .filter(Boolean)
                .join(" · ")}
              {current.doi && (
                <>
                  {" · "}
                  <a
                    className="underline underline-offset-2"
                    href={`https://doi.org/${current.doi.replace(/^https?:\/\/(dx\.)?doi\.org\//, "")}`}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    DOI
                  </a>
                </>
              )}
              {current.url && (
                <>
                  {" · "}
                  <a
                    className="underline underline-offset-2"
                    href={current.url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Link
                  </a>
                </>
              )}
            </p>
            {current.abstract ? (
              <p className="whitespace-pre-line leading-7 text-zinc-800 dark:text-zinc-200">
                <Highlighted
                  text={current.abstract}
                  include={project.include_keywords}
                  exclude={project.exclude_keywords}
                />
              </p>
            ) : (
              <p className="italic text-zinc-400 dark:text-zinc-500">
                No abstract in the export for this record.
              </p>
            )}
          </article>

          <div className="flex flex-wrap items-center justify-center gap-3 pb-2">
            <button
              onClick={() => decide("include")}
              disabled={saving}
              className={`${btn} bg-emerald-600 text-white hover:bg-emerald-500`}
            >
              Include (I)
            </button>
            <button
              onClick={() =>
                reasons.length > 0 ? setPickerOpen(true) : decide("exclude")
              }
              disabled={saving}
              className={`${btn} bg-red-600 text-white hover:bg-red-500`}
            >
              Exclude (E)
            </button>
            <button
              onClick={() => decide("maybe")}
              disabled={saving}
              className={`${btn} bg-amber-500 text-white hover:bg-amber-400`}
            >
              Maybe (M)
            </button>
            <button
              onClick={undo}
              disabled={!canUndo}
              className={`${btn} border border-zinc-300 text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800`}
            >
              Undo (U)
            </button>
          </div>
        </div>
      )}

      {pickerOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6"
          onClick={() => setPickerOpen(false)}
        >
          <div
            className="w-full max-w-md rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-700 dark:bg-zinc-900"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="mb-3 font-semibold text-zinc-900 dark:text-zinc-50">
              Exclusion reason
            </h3>
            <div className="mb-3 flex flex-col gap-1">
              {reasons.map((r, i) => (
                <button
                  key={r.id}
                  onClick={() => decide("exclude", r.id)}
                  className="flex items-center gap-3 rounded-lg px-3 py-2 text-left text-sm text-zinc-800 hover:bg-zinc-100 dark:text-zinc-200 dark:hover:bg-zinc-800"
                >
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded bg-zinc-100 text-xs font-semibold text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                    {i + 1}
                  </span>
                  {r.label}
                </button>
              ))}
            </div>
            <div className="flex justify-between text-sm text-zinc-500 dark:text-zinc-400">
              <button
                onClick={() => decide("exclude", null)}
                className="underline underline-offset-2"
              >
                Exclude without reason (Enter)
              </button>
              <button
                onClick={() => setPickerOpen(false)}
                className="underline underline-offset-2"
              >
                Cancel (Esc)
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
