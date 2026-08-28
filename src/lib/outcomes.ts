import type { Decision, Stage } from "./types";

export type RecordOutcome = "included" | "excluded" | "conflict" | "undecided";

/**
 * Team level outcome for one record at one stage, from all reviewers'
 * decisions: any include and any exclude together is a conflict; either
 * alone decides; none is undecided.
 */
export function outcomeOf(decisions: { decision: Decision | string }[]): RecordOutcome {
  const hasInclude = decisions.some((d) => d.decision === "include");
  const hasExclude = decisions.some((d) => d.decision === "exclude");
  if (hasInclude && hasExclude) return "conflict";
  if (hasInclude) return "included";
  if (hasExclude) return "excluded";
  return "undecided";
}

/** Group decisions by record id for one stage. */
export function decisionsByRecord<
  T extends { record_id: string; stage: Stage | string },
>(decisions: T[], stage: Stage): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const d of decisions) {
    if (d.stage !== stage) continue;
    const list = map.get(d.record_id) ?? [];
    list.push(d);
    map.set(d.record_id, list);
  }
  return map;
}

// ----------------------------------------------------------------------
// Independent screening (migration 0017): a stage can require several
// independent opinions per record. Below quota the record is blinded
// ("awaiting"); at quota it reveals and agreement decides; conflicts
// are settled by a resolution row, the team's logged final verdict.
// ----------------------------------------------------------------------

/** Opinions a record needs at a stage; 1 (classic) before migration. */
export function requiredFor(
  project: {
    required_opinions_ta?: number | null;
    required_opinions_ft?: number | null;
  },
  stage: Stage
): number {
  const k =
    stage === "full_text"
      ? project.required_opinions_ft
      : project.required_opinions_ta;
  return Math.max(1, k ?? 1);
}

export type StageStatus =
  | { kind: "included" | "excluded"; resolved: boolean }
  | { kind: "conflict" }
  | { kind: "awaiting"; have: number; need: number }
  | { kind: "undecided" };

/** Full team status of one record at one stage. */
export function stageStatus(
  opinions: { decision: Decision | string }[],
  resolution: { decision: Decision | string } | null | undefined,
  required: number
): StageStatus {
  if (resolution) {
    return {
      kind: resolution.decision === "include" ? "included" : "excluded",
      resolved: true,
    };
  }
  if (opinions.length === 0) return { kind: "undecided" };
  if (opinions.length < required) {
    return { kind: "awaiting", have: opinions.length, need: required };
  }
  const o = outcomeOf(opinions);
  if (o === "included") return { kind: "included", resolved: false };
  if (o === "excluded") return { kind: "excluded", resolved: false };
  if (o === "conflict") return { kind: "conflict" };
  return { kind: "undecided" };
}

/**
 * Legacy-shaped outcome that respects quota and resolutions: a record
 * below quota reads as undecided (still blinded), a revealed
 * disagreement as conflict, and a resolution as the final outcome.
 * Drop-in for consumers that fed outcomeOf directly.
 */
export function settledOutcome(
  opinions: { decision: Decision | string }[],
  resolution: { decision: Decision | string } | null | undefined,
  required: number
): RecordOutcome {
  const s = stageStatus(opinions, resolution, required);
  if (s.kind === "awaiting" || s.kind === "undecided") return "undecided";
  if (s.kind === "conflict") return "conflict";
  return s.kind;
}
