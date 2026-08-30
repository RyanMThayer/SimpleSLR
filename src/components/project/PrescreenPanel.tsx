"use client";

import { useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { keyStoreFor, modelLabel, prescreenPlan } from "@/lib/aiModels";
import {
  PRESCREEN_CALIB_STORE,
  addSample,
  estimateRun,
  formatCost,
  parseCalib,
  type PrescreenCalib,
} from "@/lib/prescreenCost";
import { requiredFor, settledOutcome } from "@/lib/outcomes";
import { fetchResolutions, resKey } from "@/lib/resolutions";
import type { Project } from "@/lib/types";

/**
 * The AI prescreen runner: diverts only unmistakably ineligible
 * records away from human screening, using a deterministic ensemble
 * of five procedural framings. Unanimity required; everything else
 * stays with humans. Validate mode replays the same pipeline on
 * records the team already screened and reports what it WOULD have
 * done, without touching anything.
 *
 * There is no model picker: the prescreen runs on prescribed models
 * chosen by which provider keys are saved (see prescreenPlan), so
 * every team screens with the same instrument and quality never
 * hinges on a bargain model choice.
 */

type Progress = { done: number; total: number };

export default function PrescreenPanel({
  project,
  onDone,
}: {
  project: Project;
  onDone: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [hasAnthropic, setHasAnthropic] = useState(false);
  const [hasOpenai, setHasOpenai] = useState(false);
  const [running, setRunning] = useState<"live" | "validate" | null>(null);
  const [prescreenedCount, setPrescreenedCount] = useState(0);
  const [restoring, setRestoring] = useState(false);
  const [unscreenedCount, setUnscreenedCount] = useState<number | null>(null);
  // Per-model tokens-per-record averages learned from real runs.
  const [calib, setCalib] = useState<PrescreenCalib>({});
  const [progress, setProgress] = useState<Progress | null>(null);
  const [summary, setSummary] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const stopRef = useRef(false);
  // The prescreen judges purely against the research question and the
  // criteria, so running is gated until all three exist; the panel
  // fetches them fresh and forces entry here if any are missing.
  const [rqText, setRqText] = useState("");
  const [incText, setIncText] = useState("");
  // Exclusion criteria ARE the exclusion reasons list (the E1..En the
  // team excludes with), so the gate checks the list, not a text box.
  const [reasonLabels, setReasonLabels] = useState<string[]>([]);
  const [newReason, setNewReason] = useState("");
  const [addingReason, setAddingReason] = useState(false);
  const [setupLoaded, setSetupLoaded] = useState(false);
  const [savingSetup, setSavingSetup] = useState(false);
  const [setupSaved, setSetupSaved] = useState(false);
  const ready =
    setupLoaded &&
    rqText.trim().length > 0 &&
    incText.trim().length > 0 &&
    reasonLabels.length > 0;
  const needsSetup = setupLoaded && (!ready || !setupSaved);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      const supabase = createClient();
      const [{ data }, { data: reasonRows }] = await Promise.all([
        supabase
          .from("projects")
          .select("research_question, inclusion_criteria")
          .eq("id", project.id)
          .single(),
        supabase
          .from("exclusion_reasons")
          .select("label")
          .eq("project_id", project.id)
          .order("position"),
      ]);
      if (cancelled) return;
      const labels = (reasonRows ?? []).map((r) => r.label as string);
      setRqText(data?.research_question ?? "");
      setIncText(data?.inclusion_criteria ?? "");
      setReasonLabels(labels);
      setSetupSaved(
        Boolean(
          data?.research_question?.trim() &&
            data?.inclusion_criteria?.trim() &&
            labels.length > 0
        )
      );
      setSetupLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, project.id]);

  async function addReason() {
    const label = newReason.trim();
    if (!label || addingReason) return;
    setAddingReason(true);
    setError(null);
    const supabase = createClient();
    const { error: insErr } = await supabase.from("exclusion_reasons").insert({
      project_id: project.id,
      label,
      position: reasonLabels.length,
    });
    setAddingReason(false);
    if (insErr) {
      setError(insErr.message);
      return;
    }
    setReasonLabels((l) => [...l, label]);
    setNewReason("");
  }

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
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setHasAnthropic(Boolean(localStorage.getItem(keyStoreFor("anthropic"))));
      setHasOpenai(Boolean(localStorage.getItem(keyStoreFor("openai"))));
    } catch {
      setHasAnthropic(false);
      setHasOpenai(false);
    }
    try {
      setCalib(parseCalib(localStorage.getItem(PRESCREEN_CALIB_STORE)));
    } catch {
      // Estimate falls back to the measured defaults.
    }
    (async () => {
      const supabase = createClient();
      const { count } = await supabase
        .from("records")
        .select("id", { count: "exact", head: true })
        .eq("project_id", project.id)
        .eq("status", "prescreen_excluded");
      setPrescreenedCount(count ?? 0);
      setUnscreenedCount((await candidateIds("live")).length);
    })();
    // candidateIds reads only stable project identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, project.id]);

  // Bulk undo: puts every AI-removed record back into screening in one
  // stroke, so the prescreen can be rerun after prompt or criteria
  // changes without restoring records one by one. The vote ledger is
  // untouched; it remains the audit trail of the earlier run.
  async function restoreAll() {
    if (restoring || running) return;
    setRestoring(true);
    setError(null);
    const supabase = createClient();
    const { error: upErr } = await supabase
      .from("records")
      .update({ status: "active" })
      .eq("project_id", project.id)
      .eq("status", "prescreen_excluded");
    setRestoring(false);
    if (upErr) {
      setError(upErr.message);
      return;
    }
    setSummary(
      `Restored ${prescreenedCount} prescreened record(s) to screening; rerun the prescreen to re-evaluate them.`
    );
    setUnscreenedCount((c) => (c === null ? null : c + prescreenedCount));
    setPrescreenedCount(0);
    onDone();
  }

  // Which model(s) this run uses follows from the saved keys alone.
  const plan = prescreenPlan(hasAnthropic, hasOpenai);

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
    if (!plan) {
      setError(
        "No API key is saved in this browser; add an Anthropic or OpenAI key under Project settings."
      );
      return;
    }
    try {
      apiKey =
        localStorage.getItem(
          keyStoreFor(plan.primary.startsWith("claude") ? "anthropic" : "openai")
        ) ?? "";
      secondApiKey = plan.partner
        ? localStorage.getItem(
            keyStoreFor(
              plan.partner.startsWith("claude") ? "anthropic" : "openai"
            )
          )
        : null;
    } catch {
      /* handled below */
    }
    if (!apiKey) {
      setError(
        "The saved API key could not be read from this browser; check Project settings."
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
    // Fold each record's billed tokens into the per-model averages;
    // records replayed from the ledger report no usage and add no
    // sample. The floor keeps stray partial retries (a single missing
    // vote refilled) from dragging the per-record average down.
    let cal: PrescreenCalib = calib;
    let calChanged = false;
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
            model: plan.primary,
            secondApiKey: secondApiKey || undefined,
            mode,
          }),
        });
        const data = await res.json().catch(() => null);
        if (data?.usage) {
          for (const [m, u] of Object.entries(
            data.usage as Record<
              string,
              { inputTokens: number; outputTokens: number }
            >
          )) {
            if ((u?.inputTokens ?? 0) >= 1500) {
              cal = addSample(cal, m, u.inputTokens, u.outputTokens);
              calChanged = true;
            }
          }
        }
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
    if (calChanged) {
      setCalib(cal);
      try {
        localStorage.setItem(PRESCREEN_CALIB_STORE, JSON.stringify(cal));
      } catch {
        // Session-only calibration.
      }
    }
    if (mode === "live") {
      setUnscreenedCount((await candidateIds("live")).length);
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
            className="flex max-h-[85vh] w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-zinc-200 bg-white text-left dark:border-zinc-800 dark:bg-zinc-900"
          >
            <div className="flex min-h-0 flex-col gap-4 overflow-y-auto p-6">
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
              Removed records are counted in the PRISMA diagram as
              ineligible by automation, stay browsable under the records
              filter, and can be restored with one click. Records with
              little or no abstract are removed only when the title alone
              makes ineligibility unmistakable (proceedings front matter,
              calls for papers, and similar search debris); anything less
              certain goes to humans. The prescreen is only as accurate
              as the criteria it is given: every removal must ground in
              the written wording of one criterion, so a criterion that
              says less than you mean will be applied as written, not as
              intended.
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
                    className="min-h-28 rounded-lg border border-amber-300 bg-white px-2 py-1.5 text-sm font-normal text-zinc-900 outline-none dark:border-amber-800 dark:bg-zinc-950 dark:text-zinc-50"
                  />
                </label>
                <label className="flex flex-col gap-1 text-xs font-medium text-amber-900 dark:text-amber-100">
                  Inclusion criteria
                  <textarea
                    value={incText}
                    onChange={(e) => setIncText(e.target.value)}
                    className="min-h-24 rounded-lg border border-amber-300 bg-white px-2 py-1.5 text-sm font-normal text-zinc-900 outline-none dark:border-amber-800 dark:bg-zinc-950 dark:text-zinc-50"
                  />
                </label>
                <div className="flex flex-col gap-1 text-xs font-medium text-amber-900 dark:text-amber-100">
                  Exclusion criteria (the exclusion reasons list)
                  {reasonLabels.length > 0 ? (
                    <ul className="text-sm font-normal text-zinc-800 dark:text-zinc-200">
                      {reasonLabels.map((l, i) => (
                        <li key={i}>
                          E{i + 1}: {l}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-sm font-normal">
                      None yet. Add at least one; these are the same E1 to
                      En reasons the team excludes with while screening.
                    </p>
                  )}
                  <div className="flex gap-1.5">
                    <input
                      value={newReason}
                      onChange={(e) => setNewReason(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") addReason();
                      }}
                      placeholder="Add an exclusion reason"
                      className="h-8 min-w-0 flex-1 rounded-lg border border-amber-300 bg-white px-2 text-sm font-normal text-zinc-900 outline-none dark:border-amber-800 dark:bg-zinc-950 dark:text-zinc-50"
                    />
                    <button
                      onClick={addReason}
                      disabled={addingReason || !newReason.trim()}
                      className="rounded-full border border-amber-400 px-3 text-sm font-normal transition-colors hover:bg-amber-100 disabled:opacity-50 dark:border-amber-700 dark:hover:bg-amber-900"
                    >
                      Add
                    </button>
                  </div>
                </div>
                <button
                  onClick={saveSetup}
                  disabled={!ready || savingSetup}
                  className="self-start rounded-full bg-amber-700 px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-amber-800 disabled:opacity-50"
                >
                  {savingSetup ? "Saving..." : "Save and unlock the prescreen"}
                </button>
              </div>
            )}

            {plan && (
              <p className="text-xs text-zinc-500 dark:text-zinc-400">
                {plan.partner
                  ? `The prescreen runs on its prescribed models: five procedures vote, split across ${modelLabel(plan.primary)} and ${modelLabel(plan.partner)} (cross provider). Removal requires unanimous votes citing the same criterion with verbatim evidence, then survives a final plausibility check.`
                  : `The prescreen runs on its prescribed model for your saved key: five procedures vote on ${modelLabel(plan.primary)}. Removal requires unanimous votes citing the same criterion with verbatim evidence, then survives a final plausibility check. Saving the other provider's key splits the vote across both providers.`}
              </p>
            )}

            {plan && unscreenedCount !== null && unscreenedCount > 0 && (
              (() => {
                const est = estimateRun(calib, plan, unscreenedCount);
                return (
                  <p className="text-xs text-zinc-500 dark:text-zinc-400">
                    Estimated cost: {formatCost(est.total)} for the{" "}
                    {unscreenedCount} unscreened record(s), at{" "}
                    {formatCost(est.perRecord)} per record
                    {est.learned
                      ? ", learned from your own runs"
                      : " (typical; your runs refine this)"}
                    .
                  </p>
                );
              })()
            )}

            {!plan && (
              <p className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100">
                No API key is saved in this browser. Add an Anthropic or
                OpenAI key under Project settings; the prescreen picks its
                models from the provider of the key you save.
              </p>
            )}

            <div className="flex flex-wrap items-center gap-2">
              <button
                onClick={() => run("validate")}
                disabled={running !== null || !plan || !setupSaved}
                className={btn}
                title="Dry run on records your team already screened: reports what the prescreen WOULD have removed and whether any human include would have been lost. Changes nothing."
              >
                {running === "validate" ? "Validating..." : "Validate on screened records"}
              </button>
              <button
                onClick={() => run("live")}
                disabled={running !== null || !plan || !setupSaved}
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
              {prescreenedCount > 0 && !running && (
                <button
                  onClick={restoreAll}
                  disabled={restoring}
                  className={btn}
                  title="Puts every AI-removed record back into screening so the prescreen can be rerun; stored votes stay as the audit trail"
                >
                  {restoring
                    ? "Restoring..."
                    : `Restore all ${prescreenedCount} prescreened record(s)`}
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
        </div>
      )}
    </>
  );
}
