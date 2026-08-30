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

/**
 * Records sitting mid independent screening: opinions recorded but the
 * stage's quota not yet met. Views gated on settled outcomes (reading
 * room, concept matrix, snowball seeds) surface these counts so a
 * reviewer who already screened a paper knows it is waiting on
 * teammates, not lost. `ta` holds records still collecting
 * title/abstract opinions; `ft` holds settled title/abstract includes
 * still collecting full text opinions. Both are empty by construction
 * when every stage requires a single opinion.
 */
export function awaitingTeammates(input: {
  ta: Map<string, { decision: Decision | string }[]>;
  ft: Map<string, { decision: Decision | string }[]>;
  resolutionFor: (
    stage: Stage,
    recordId: string
  ) => { decision: Decision | string } | undefined;
  taRequired: number;
  ftRequired: number;
}): { ta: string[]; ft: string[] } {
  const taIds: string[] = [];
  const ftIds: string[] = [];
  for (const [id, decs] of input.ta) {
    const ta = stageStatus(
      decs,
      input.resolutionFor("title_abstract", id) ?? null,
      input.taRequired
    );
    if (ta.kind === "awaiting") {
      taIds.push(id);
      continue;
    }
    if (ta.kind !== "included") continue;
    const ftDecs = input.ft.get(id);
    // No full text opinions yet is the ordinary queue state, not a
    // teammate wait.
    if (!ftDecs || ftDecs.length === 0) continue;
    const ft = stageStatus(
      ftDecs,
      input.resolutionFor("full_text", id) ?? null,
      input.ftRequired
    );
    if (ft.kind === "awaiting") ftIds.push(id);
  }
  return { ta: taIds, ft: ftIds };
}
