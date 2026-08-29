/**
 * The models SimpleSLR's AI features can call, with provider routing
 * and list prices (USD per million input/output tokens) for the cost
 * preview. One source of truth shared by the reading room, the
 * prescreen, and the server allowlists.
 */

export const AI_MODELS = [
  {
    id: "claude-sonnet-5",
    label: "Claude Sonnet 5",
    provider: "anthropic",
    inPerMTok: 2,
    outPerMTok: 10,
  },
  {
    id: "claude-opus-5",
    label: "Claude Opus 5",
    provider: "anthropic",
    inPerMTok: 5,
    outPerMTok: 25,
  },
  {
    id: "claude-fable-5",
    label: "Claude Fable 5",
    provider: "anthropic",
    inPerMTok: 10,
    outPerMTok: 50,
  },
  {
    id: "gpt-5.6-sol",
    label: "GPT-5.6 Sol",
    provider: "openai",
    inPerMTok: 5,
    outPerMTok: 30,
  },
  {
    id: "gpt-5.6-terra",
    label: "GPT-5.6 Terra",
    provider: "openai",
    inPerMTok: 2,
    outPerMTok: 12,
  },
  {
    id: "gpt-5.6-luna",
    label: "GPT-5.6 Luna",
    provider: "openai",
    inPerMTok: 0.2,
    outPerMTok: 1.2,
  },
] as const;

export type AiModelId = (typeof AI_MODELS)[number]["id"];
export type AiProvider = "anthropic" | "openai";

export const MODEL_PROVIDERS: Record<string, AiProvider> = Object.fromEntries(
  AI_MODELS.map((m) => [m.id, m.provider])
);

export function providerOf(model: string): AiProvider {
  return MODEL_PROVIDERS[model] ?? "anthropic";
}

export function keyStoreFor(provider: AiProvider): string {
  return `simpleslr-${provider}-key`;
}

/**
 * The fixed cross-provider partner for prescreen voting: one solid
 * mid-tier model from the other provider, deliberately not
 * configurable so runs stay simple to report and reproduce.
 */
export function partnerModelFor(primary: string): AiModelId {
  return providerOf(primary) === "anthropic" ? "gpt-5.6-terra" : "claude-sonnet-5";
}
