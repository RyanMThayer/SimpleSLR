"use client";

import { useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import {
  AI_MODELS,
  keyStoreFor,
  partnerModelFor,
  providerOf,
  type AiModelId,
} from "@/lib/aiModels";
import { requiredFor, settledOutcome } from "@/lib/outcomes";
import { fetchResolutions, resKey } from "@/lib/resolutions";
import type { Project } from "@/lib/types";

/**
 * The AI prescreen runner: diverts only unmistakably ineligible
 * records away from human screening, using a deterministic ensemble
 * (three procedural framings, plus two more on a cross provider
 * partner model when its key is saved). Unanimity required; everything
 * else stays with humans. Validate mode replays the same pipeline on
 * records the team already screened and reports what it WOULD have
 * done, without touching anything.
 */

const PRESCREEN_MODEL_STORE = "simpleslr-prescreen-model";

type Progress = { done: number; total: number };

export default function PrescreenPanel({
  project,
  onDone,
}: {
  project: Project;
  onDone: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [model, setModel] = useState<AiModelId>("claude-sonnet-5");
  const [hasKey, setHasKey] = useState(false);
  const [hasPartnerKey, setHasPartnerKey] = useState(false);
  const [running, setRunning] = useState<"live" | "validate" | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [summary, setSummary] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const stopRef = useRef(false);
  // The prescreen judges purely against the research question and the
  // criteria, so running is gated until all three exist; the panel
  // fetches them fresh and forces entry here if any are missing.
  const [rqText, setRqText] = useState("");
  const [incText, setIncText] = useState("");
  const [excText, setExcText] = useState("");
  const [setupLoaded, setSetupLoaded] = useState(false);
  const [savingSetup, setSavingSetup] = useState(false);
  const [setupSaved, setSetupSaved] = useState(false);
  const ready =
    setupLoaded &&
    rqText.trim().length > 0 &&
    incText.trim().length > 0 &&
    excText.trim().length > 0;
  const needsSetup = setupLoaded && (!ready || !setupSaved);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      const supabase = createClient();
      const { data } = await supabase
        .from("projects")
        .select("research_question, inclusion_criteria, exclusion_criteria")
        .eq("id", project.id)
        .single();
      if (cancelled) return;
      setRqText(data?.research_question ?? "");
      setIncText(data?.inclusion_criteria ?? "");
      setExcText(data?.exclusion_criteria ?? "");
      setSetupSaved(
        Boolean(
          data?.research_question?.trim() &&
            data?.inclusion_criteria?.trim() &&
            data?.exclusion_criteria?.trim()
        )
      );
      setSetupLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, project.id]);

  async function saveSetup() {
    if (!ready || savingSetup) return;
    setSavingSetup(true);
    setError(null);
    const supabase = createClient();
    const { error: upErr } = await supabase
      .from("projects")
      .update({
        research_question: rqText.trim(),
        inclusion_criteria: incText.trim(),
        exclusion_criteria: excText.trim(),
      })
      .eq("id", project.id);
    setSavingSetup(false);
    if (upErr) {
      setError(upErr.message);
      return;
    }
    setSetupSaved(true);
  }

  useEffect(() => {
    if (!open) return;
    try {
      const stored = localStorage.getItem(PRESCREEN_MODEL_STORE);
      if (stored && AI_MODELS.some((m) => m.id === stored)) {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setModel(stored as AiModelId);
      }
    } catch {
      // Default stands.
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    try {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setHasKey(Boolean(localStorage.getItem(keyStoreFor(providerOf(model)))));
      setHasPartnerKey(
        Boolean(
          localStorage.getItem(
            keyStoreFor(providerOf(partnerModelFor(model)))
          )
        )
      );
    } catch {
      setHasKey(false);
      setHasPartnerKey(false);
    }
  }, [open, model]);

  function chooseModel(id: AiModelId) {
    setModel(id);
    try {
      localStorage.setItem(PRESCREEN_MODEL_STORE, id);
    } catch {
      // Session only.
    }
  }

  async function candidateIds(mode: "live" | "validate"): Promise<string[]> {
    const supabase = createClient();
    const active: string[] = [];
    for (let from = 0; ; from += 1000) {
      const { data } = await supabase
        .from("records")
        .select("id")
        .eq("project_id", project.id)
        .eq("status", "active")
        .order("created_at")
        .range(from, from + 999);
      (data ?? []).forEach((r) => active.push(r.id));
      if (!data || data.length < 1000) break;
    }
    const decided = new Set<string>();
    for (let from = 0; ; from += 1000) {
      const { data } = await supabase
        .from("screening_decisions")
        .select("record_id")
        .eq("project_id", project.id)
        .eq("stage", "title_abstract")
        .range(from, from + 999);
      (data ?? []).forEach((d) => decided.add(d.record_id));
      if (!data || data.length < 1000) break;
    }
    return mode === "live"
      ? active.filter((id) => !decided.has(id))
      : active.filter((id) => decided.has(id));
  }

  async function run(mode: "live" | "validate") {
    if (running) return;
    setError(null);
    setSummary(null);
    stopRef.current = false;
    let apiKey = "";
    let secondApiKey: string | null = null;
    try {
      apiKey = localStorage.getItem(keyStoreFor(providerOf(model))) ?? "";
      secondApiKey = localStorage.getItem(
        keyStoreFor(providerOf(partnerModelFor(model)))
      );
    } catch {
      /* handled below */
    }
    if (!apiKey) {
      setError(
        `No ${providerOf(model) === "anthropic" ? "Anthropic" : "OpenAI"} API key is saved in this browser; add one in the reading room's AI card first.`
      );
      return;
    }
    setRunning(mode);
    const ids = await candidateIds(mode);
    if (ids.length === 0) {
      setRunning(null);
      setSummary(
        mode === "live"
          ? "No unscreened records to prescreen; every active record already has a human decision."
          : "Nothing to validate against: no records have human title/abstract decisions yet."
      );
      return;
    }
    // For validation: the settled human outcome per record, to compare.
    const humanIncluded = new Set<string>();
    if (mode === "validate") {
      const supabase = createClient();
      const byRecord = new Map<string, { decision: string }[]>();
      for (let from = 0; ; from += 1000) {
        const { data } = await supabase
          .from("screening_decisions")
          .select("record_id, decision")
          .eq("project_id", project.id)
          .eq("stage", "title_abstract")
          .range(from, from + 999);
        (data ?? []).forEach((d) => {
          const list = byRecord.get(d.record_id) ?? [];
          list.push(d);
          byRecord.set(d.record_id, list);
        });
        if (!data || data.length < 1000) break;
      }
      const resMap = await fetchResolutions(supabase, project.id);
      const req = requiredFor(project, "title_abstract");
      for (const id of ids) {
        if (
          settledOutcome(
            byRecord.get(id) ?? [],
            resMap.get(resKey("title_abstract", id)),
            req
          ) === "included"
        ) {
          humanIncluded.add(id);
        }
      }
    }

    let excluded = 0;
    let passed = 0;
    let skipped = 0;
    let failed = 0;
    let missedIncludes = 0;
    setProgress({ done: 0, total: ids.length });
    for (let i = 0; i < ids.length; i++) {
      if (stopRef.current) break;
      try {
        const res = await fetch("/api/prescreen", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            projectId: project.id,
            recordId: ids[i],
            apiKey,
            model,
            secondApiKey: secondApiKey || undefined,
            mode,
          }),
        });
        const data = await res.json().catch(() => null);
        if (!data || data.error) failed++;
        else if (data.skipped) skipped++;
        else if (data.excluded) {
          excluded++;
          if (mode === "validate" && humanIncluded.has(ids[i])) {
            missedIncludes++;
          }
        } else passed++;
      } catch {
        failed++;
      }
      setProgress({ done: i + 1, total: ids.length });
    }
    setRunning(null);
    const stopNote = stopRef.current ? " (stopped early)" : "";
    if (mode === "live") {
      setSummary(
        `Prescreen${stopNote}: ${excluded} record(s) removed as clearly ineligible, ${passed} passed to human screening, ${skipped} skipped (already screened)${failed > 0 ? `, ${failed} failed (rerun to retry; stored votes are reused)` : ""}.`
      );
      onDone();
    } else {
      setSummary(
        `Validation${stopNote} on ${ids.length} human screened record(s): the prescreen would have removed ${excluded}, of which ${missedIncludes} ${missedIncludes === 1 ? "was" : "were"} included by your team. ${missedIncludes === 0 ? "No human include would have been lost; that sentence can go in your methods section." : "It would have removed records your team included; do not enable it for this review without tightening the criteria."}${failed > 0 ? ` ${failed} record(s) failed to evaluate.` : ""}`
      );
    }
  }

  const btn =
    "rounded-full border border-zinc-300 px-3 py-1.5 text-sm text-zinc-700 transition-colors hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800";

  return (
    <>
      <button onClick={() => setOpen(true)} className={btn}>
        AI prescreen
      </button>
      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-950/50 p-4"
          onClick={() => {
            if (!running) setOpen(false);
          }}
        >
          <div
            role="dialog"
            aria-label="AI prescreen"
            onClick={(e) => e.stopPropagation()}
            className="flex max-h-[85vh] w-full max-w-xl flex-col gap-4 overflow-y-auto rounded-2xl border border-zinc-200 bg-white p-6 text-left dark:border-zinc-800 dark:bg-zinc-900"
          >
            <div className="flex items-start justify-between gap-3">
              <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">
                AI prescreen
              </h2>
              <button
                onClick={() => setOpen(false)}
                disabled={running !== null}
                aria-label="Close"
                className="rounded-full px-2 py-0.5 text-sm text-zinc-500 hover:bg-zinc-100 disabled:opacity-40 dark:text-zinc-400 dark:hover:bg-zinc-800"
              >
                ✕
              </button>
            </div>

            <p className="text-sm text-zinc-600 dark:text-zinc-400">
              Removes only records that are unmistakably outside your
              criteria, before human screening. Each record is judged by
              three independent procedures
              {hasPartnerKey
                ? ", plus two more on a second model from the other provider,"
                : ""}{" "}
              at deterministic settings, and is removed ONLY if every vote
              says exclude with a verifiable criterion; one dissent keeps it
              in your queue. Removed records are counted in the PRISMA
              diagram as ineligible by automation, stay browsable under the
              records filter, and can be restored with one click. Records
              with little or no abstract are removed only when the title
              alone makes ineligibility unmistakable (proceedings front
              matter, calls for papers, and similar search debris);
              anything less certain goes to humans.
            </p>

            {needsSetup && (
              <div className="flex flex-col gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 dark:border-amber-700 dark:bg-amber-950">
                <p className="text-sm font-medium text-amber-900 dark:text-amber-100">
                  Before the AI can screen anything, it needs the exact
                  yardsticks your team screens by. It judges purely against
                  these three fields; fill in and save whatever is missing.
                </p>
                <label className="flex flex-col gap-1 text-xs font-medium text-amber-900 dark:text-amber-100">
                  Research question(s)
                  <textarea
                    value={rqText}
                    onChange={(e) => setRqText(e.target.value)}
                    className="min-h-14 rounded-lg border border-amber-300 bg-white px-2 py-1.5 text-sm font-normal text-zinc-900 outline-none dark:border-amber-800 dark:bg-zinc-950 dark:text-zinc-50"
                  />
                </label>
                <label className="flex flex-col gap-1 text-xs font-medium text-amber-900 dark:text-amber-100">
                  Inclusion criteria
                  <textarea
                    value={incText}
                    onChange={(e) => setIncText(e.target.value)}
                    className="min-h-14 rounded-lg border border-amber-300 bg-white px-2 py-1.5 text-sm font-normal text-zinc-900 outline-none dark:border-amber-800 dark:bg-zinc-950 dark:text-zinc-50"
                  />
                </label>
                <label className="flex flex-col gap-1 text-xs font-medium text-amber-900 dark:text-amber-100">
                  Exclusion criteria
                  <textarea
                    value={excText}
                    onChange={(e) => setExcText(e.target.value)}
                    className="min-h-14 rounded-lg border border-amber-300 bg-white px-2 py-1.5 text-sm font-normal text-zinc-900 outline-none dark:border-amber-800 dark:bg-zinc-950 dark:text-zinc-50"
                  />
                </label>
                <button
                  onClick={saveSetup}
                  disabled={!ready || savingSetup}
                  className="self-start rounded-full bg-amber-700 px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-amber-800 disabled:opacity-50"
                >
                  {savingSetup ? "Saving..." : "Save and unlock the prescreen"}
                </button>
              </div>
            )}

            <div className="flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-2 text-sm font-medium text-zinc-700 dark:text-zinc-300">
                Model
                <select
                  value={model}
                  onChange={(e) => chooseModel(e.target.value as AiModelId)}
                  disabled={running !== null}
                  className="h-8 rounded-lg border border-zinc-300 bg-white px-2 text-sm text-zinc-900 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50"
                >
                  {AI_MODELS.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </label>
              <span className="text-xs text-zinc-500 dark:text-zinc-400">
                {hasPartnerKey
                  ? `5 votes: 3 on ${model}, 2 on ${partnerModelFor(model)} (cross provider).`
                  : `3 votes on ${model}; save the other provider's key to add 2 cross provider votes.`}
              </span>
            </div>

            {!hasKey && (
              <p className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100">
                No API key for this model&apos;s provider is saved in this
                browser. Add one in the reading room&apos;s AI card first.
              </p>
            )}

            <div className="flex flex-wrap items-center gap-2">
              <button
                onClick={() => run("validate")}
                disabled={running !== null || !hasKey || !setupSaved}
                className={btn}
                title="Dry run on records your team already screened: reports what the prescreen WOULD have removed and whether any human include would have been lost. Changes nothing."
              >
                {running === "validate" ? "Validating..." : "Validate on screened records"}
              </button>
              <button
                onClick={() => run("live")}
                disabled={running !== null || !hasKey || !setupSaved}
                className="rounded-full bg-teal-700 px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-teal-800 disabled:opacity-50 dark:bg-teal-400 dark:text-teal-950 dark:hover:bg-teal-300"
                title="Evaluates every unscreened record; unanimously ineligible ones move out of the screening queues."
              >
                {running === "live" ? "Prescreening..." : "Run on unscreened records"}
              </button>
              {running && (
                <button
                  onClick={() => {
                    stopRef.current = true;
                  }}
                  className={btn}
                >
                  Stop
                </button>
              )}
            </div>

            {progress && running && (
              <div>
                <div className="mb-1 h-2 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
                  <div
                    className="h-full rounded-full bg-teal-600 transition-all dark:bg-teal-400"
                    style={{
                      width: `${Math.round((progress.done / Math.max(1, progress.total)) * 100)}%`,
                    }}
                  />
                </div>
                <p className="text-xs tabular-nums text-zinc-500 dark:text-zinc-400">
                  {progress.done} / {progress.total} records evaluated (safe
                  to stop; finished votes are kept and reused)
                </p>
              </div>
            )}

            {summary && (
              <p className="rounded-lg border border-teal-300 bg-teal-50 px-3 py-2 text-sm text-teal-900 dark:border-teal-800 dark:bg-teal-950 dark:text-teal-100">
                {summary}
              </p>
            )}
            {error && (
              <p className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
                {error}
              </p>
            )}
          </div>
        </div>
      )}
    </>
  );
}
