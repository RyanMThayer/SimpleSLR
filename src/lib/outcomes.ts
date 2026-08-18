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
