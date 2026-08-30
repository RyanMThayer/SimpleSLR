import { AI_MODELS } from "./aiModels";

/**
 * Prescreen cost estimation, learned from real runs. The route relays
 * the billed token usage of every fresh API call, the panel folds it
 * into a per-model running average of tokens per RECORD, and the
 * estimate shown before a run uses those averages once enough samples
 * exist. Until then it falls back to measured defaults (seeded from a
 * real 97-record run: about 1.82 cents per record on GPT-5.6 Terra).
 * Stored in this browser only, like the reading room's calibration.
 */

export const PRESCREEN_CALIB_STORE = "simpleslr-prescreen-calib";

/** Per model: token totals over sampled records, kept as running sums. */
export type PrescreenCalib = Record<
  string,
  { records: number; inTok: number; outTok: number }
>;

/** Tokens one fresh single-model record costs (extraction + 5 votes),
 * solved from the measured 1.82 cents/record on GPT-5.6 Terra. */
export const DEFAULT_RECORD_TOKENS = { inTok: 5200, outTok: 650 };

/** Samples needed before a learned average replaces the default. */
const MIN_SAMPLES = 3;

export function parseCalib(raw: string | null): PrescreenCalib {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object"
      ? (parsed as PrescreenCalib)
      : {};
  } catch {
    return {};
  }
}

export function addSample(
  calib: PrescreenCalib,
  model: string,
  inTok: number,
  outTok: number
): PrescreenCalib {
  const cur = calib[model] ?? { records: 0, inTok: 0, outTok: 0 };
  return {
    ...calib,
    [model]: {
      records: cur.records + 1,
      inTok: cur.inTok + inTok,
      outTok: cur.outTok + outTok,
    },
  };
}

function priceOf(model: string): { inPerMTok: number; outPerMTok: number } {
  const m = AI_MODELS.find((x) => x.id === model);
  return m ?? { inPerMTok: 2, outPerMTok: 12 };
}

function modelRecordCost(
  calib: PrescreenCalib,
  model: string,
  defaultShare: number
): { dollars: number; learned: boolean } {
  const p = priceOf(model);
  const c = calib[model];
  if (c && c.records >= MIN_SAMPLES) {
    // Learned averages already reflect this model's real share of the
    // work (single or split), so no share factor applies.
    const avgIn = c.inTok / c.records;
    const avgOut = c.outTok / c.records;
    return {
      dollars: (avgIn * p.inPerMTok + avgOut * p.outPerMTok) / 1e6,
      learned: true,
    };
  }
  const inTok = DEFAULT_RECORD_TOKENS.inTok * defaultShare;
  const outTok = DEFAULT_RECORD_TOKENS.outTok * defaultShare;
  return {
    dollars: (inTok * p.inPerMTok + outTok * p.outPerMTok) / 1e6,
    learned: false,
  };
}

/**
 * Estimated cost of prescreening `records` records under a plan.
 * Single model: the whole record's tokens on that model. Dual: the
 * primary carries its own extraction plus three votes (about 0.65 of
 * a single-model record), the partner its extraction plus two votes
 * (about 0.5); the overlap is the duplicated extraction.
 */
export function estimateRun(
  calib: PrescreenCalib,
  plan: { primary: string; partner: string | null },
  records: number
): { perRecord: number; total: number; learned: boolean } {
  const primary = modelRecordCost(calib, plan.primary, plan.partner ? 0.65 : 1);
  const partner = plan.partner
    ? modelRecordCost(calib, plan.partner, 0.5)
    : null;
  const perRecord = primary.dollars + (partner?.dollars ?? 0);
  return {
    perRecord,
    total: perRecord * Math.max(0, records),
    learned: primary.learned && (partner ? partner.learned : true),
  };
}

/** "~1.8¢" under a dollar, "~$1.77" from there up. */
export function formatCost(dollars: number): string {
  if (dollars < 0.995) return `~${(dollars * 100).toFixed(1)}¢`;
  return `~$${dollars.toFixed(2)}`;
}
