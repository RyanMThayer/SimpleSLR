/**
 * Cost prediction for the AI pass, built to get sharper over time.
 *
 * Input size starts from MEASURED characters (the client counts the
 * paper's real text via pdf.js, so blank or dense pages weigh what
 * they actually weigh) plus the measured prompt overhead. Characters
 * become tokens through a per-model ratio: a calibrated default until
 * the first real run, then the ratio observed from the provider's own
 * billed usage, updated as a running average. Output starts at a
 * typical figure and likewise becomes that model's observed average.
 * The maximum is honest arithmetic: the server caps responses at
 * MAX_OUTPUT_TOKENS, so with input known the worst case is bounded.
 *
 * Pure and I/O free for unit testing; persistence lives with the
 * caller.
 */

export type CalibEntry = { charsPerToken: number; avgOut: number; runs: number };
export type Calib = Record<string, CalibEntry>;
export type PricedModel = { id: string; inPerMTok: number; outPerMTok: number };
export type RunUsage = {
  inputChars: number;
  inputTokens: number;
  outputTokens: number;
};

// Academic prose tokenizes denser than everyday English (citations,
// numbers, technical vocabulary), so 3.6 chars/token, not the folk 4.
export const DEFAULT_CHARS_PER_TOKEN = 3.6;
export const DEFAULT_OUTPUT_TOKENS = 2000;
export const MAX_OUTPUT_TOKENS = 8000;

/** Fold one real run's billed usage into the model's running averages. */
export function updateCalib(prev: Calib, modelId: string, u: RunUsage): Calib {
  if (u.inputTokens <= 0 || u.inputChars <= 0 || u.outputTokens < 0) {
    return prev;
  }
  const ratio = u.inputChars / u.inputTokens;
  const e = prev[modelId];
  const runs = (e?.runs ?? 0) + 1;
  return {
    ...prev,
    [modelId]: {
      charsPerToken: e
        ? e.charsPerToken + (ratio - e.charsPerToken) / runs
        : ratio,
      avgOut: e ? e.avgOut + (u.outputTokens - e.avgOut) / runs : u.outputTokens,
      runs,
    },
  };
}

/** Typical and worst-case USD for one pass with `inputChars` of input. */
export function estimateCost(
  model: PricedModel,
  inputChars: number,
  calib: Calib
): { typical: number; max: number } {
  const e = calib[model.id];
  const inTok = inputChars / (e?.charsPerToken ?? DEFAULT_CHARS_PER_TOKEN);
  const outTok = e?.avgOut ?? DEFAULT_OUTPUT_TOKENS;
  const inUsd = (inTok * model.inPerMTok) / 1_000_000;
  return {
    typical: inUsd + (outTok * model.outPerMTok) / 1_000_000,
    max: inUsd + (MAX_OUTPUT_TOKENS * model.outPerMTok) / 1_000_000,
  };
}

export function formatCost(usd: number): string {
  if (usd < 0.01) return "<1¢";
  if (usd < 1) return `~${Math.round(usd * 100)}¢`;
  return `~$${usd.toFixed(2)}`;
}
