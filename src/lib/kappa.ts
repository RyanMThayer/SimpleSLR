import type { Decision } from "./types";

/**
 * Inter-rater reliability for the screening stages, reported on the
 * Report page fact sheet. Cohen's kappa when the dual-screened subset
 * was rated by exactly two reviewers (the textbook case); Fleiss'
 * kappa when more reviewers contributed, since it treats the rater
 * pair behind each record as a draw from the team. Computed over the
 * recorded independent opinions; conflict resolutions live in their
 * own table and never enter the statistic.
 */

export type KappaResult = {
  statistic: "cohen" | "fleiss";
  /** Null when the statistic is undefined (no variation in decisions). */
  value: number | null;
  /** Records that entered the computation. */
  records: number;
  /** Distinct reviewers behind those records. */
  raters: number;
};

export type DecisionLite = {
  record_id: string;
  decided_by: string;
  decision: Decision;
  decided_at: string;
};

/** Landis and Koch (1977) interpretation band for a kappa value. */
export function landisKoch(k: number): string {
  if (k < 0) return "poor";
  if (k <= 0.2) return "slight";
  if (k <= 0.4) return "fair";
  if (k <= 0.6) return "moderate";
  if (k <= 0.8) return "substantial";
  return "almost perfect";
}

/**
 * Cohen's kappa over ordered rating pairs from two fixed raters.
 * Returns null when chance agreement is 1 (both raters constant), in
 * which case the statistic is undefined.
 */
export function cohenKappa(pairs: [Decision, Decision][]): number | null {
  const n = pairs.length;
  if (n === 0) return null;
  let agree = 0;
  const aInc = { include: 0, exclude: 0 };
  const bInc = { include: 0, exclude: 0 };
  for (const [a, b] of pairs) {
    if (a === b) agree++;
    aInc[a]++;
    bInc[b]++;
  }
  const po = agree / n;
  const pe =
    (aInc.include / n) * (bInc.include / n) +
    (aInc.exclude / n) * (bInc.exclude / n);
  if (1 - pe === 0) return null;
  return (po - pe) / (1 - pe);
}

/**
 * Fleiss' kappa over subjects that each received the same number of
 * ratings. Rows are per-record category counts [include, exclude].
 * Returns null when chance agreement is 1.
 */
export function fleissKappa(rows: [number, number][]): number | null {
  const N = rows.length;
  if (N === 0) return null;
  const n = rows[0][0] + rows[0][1];
  if (n < 2) return null;
  let sumPi = 0;
  let totInc = 0;
  let totExc = 0;
  for (const [inc, exc] of rows) {
    sumPi += (inc * inc + exc * exc - n) / (n * (n - 1));
    totInc += inc;
    totExc += exc;
  }
  const pBar = sumPi / N;
  const pInc = totInc / (N * n);
  const pExc = totExc / (N * n);
  const peBar = pInc * pInc + pExc * pExc;
  if (1 - peBar === 0) return null;
  return (pBar - peBar) / (1 - peBar);
}

/**
 * Reliability for one stage from its decision rows. Keeps each
 * reviewer's latest opinion per record, uses records with at least
 * two opinions, and picks the statistic by how many reviewers stand
 * behind that subset. Returns null when nothing was dual screened.
 */
export function stageKappa(decisions: DecisionLite[]): KappaResult | null {
  // Latest opinion per (record, reviewer).
  const latest = new Map<string, DecisionLite>();
  for (const d of decisions) {
    const key = `${d.record_id}:${d.decided_by}`;
    const prev = latest.get(key);
    if (!prev || d.decided_at > prev.decided_at) latest.set(key, d);
  }
  const byRecord = new Map<string, DecisionLite[]>();
  for (const d of latest.values()) {
    const list = byRecord.get(d.record_id) ?? [];
    list.push(d);
    byRecord.set(d.record_id, list);
  }
  const multi = [...byRecord.values()].filter((l) => l.length >= 2);
  if (multi.length < 2) return null;

  const raters = new Set(multi.flat().map((d) => d.decided_by));

  if (raters.size === 2) {
    const [r1, r2] = [...raters].sort();
    const pairs: [Decision, Decision][] = multi.map((l) => {
      const a = l.find((d) => d.decided_by === r1)!;
      const b = l.find((d) => d.decided_by === r2)!;
      return [a.decision, b.decision];
    });
    return {
      statistic: "cohen",
      value: cohenKappa(pairs),
      records: pairs.length,
      raters: 2,
    };
  }

  // More than two reviewers: Fleiss over the modal opinion count, so
  // every subject carries the same number of ratings.
  const countOf = new Map<number, number>();
  for (const l of multi) countOf.set(l.length, (countOf.get(l.length) ?? 0) + 1);
  const modalN = [...countOf.entries()].sort(
    (a, b) => b[1] - a[1] || b[0] - a[0]
  )[0][0];
  const rows: [number, number][] = multi
    .filter((l) => l.length === modalN)
    .map((l) => {
      const inc = l.filter((d) => d.decision === "include").length;
      return [inc, l.length - inc];
    });
  if (rows.length < 2) return null;
  return {
    statistic: "fleiss",
    value: fleissKappa(rows),
    records: rows.length,
    raters: raters.size,
  };
}

/** Fact-sheet phrasing for one stage's reliability result. */
export function kappaPhrase(r: KappaResult): string {
  const name = r.statistic === "cohen" ? "Cohen's" : "Fleiss'";
  const scope = `${r.records} records dual screened by ${r.raters} reviewers`;
  if (r.value === null) {
    return `${name} kappa not computable (no variation in the recorded decisions) · ${scope}`;
  }
  const rounded = r.value.toFixed(2);
  return `${name} kappa = ${rounded} (${landisKoch(r.value)} agreement, Landis and Koch) · ${scope}`;
}
