import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { MODEL_PROVIDERS, partnerModelFor } from "@/lib/aiModels";
import {
  FRAMINGS,
  PARTNER_FRAMINGS,
  PRESCREEN_PROMPT_VERSION,
  PRIMARY_DUAL_FRAMINGS,
  criteriaHash,
  extractionPrompt,
  factsUserPrompt,
  parseExtraction,
  parseVeto,
  parseVote,
  unanimousExclude,
  vetoPrompt,
  votePrompt,
  voteUserPrompt,
  type Framing,
} from "@/lib/prescreen";

/**
 * One record, one prescreen evaluation. Deterministic by design:
 * temperature 0 (seed pinned where supported), diversity from framings
 * and models only, and votes are stored once per (record, framing,
 * model, prompt version, criteria hash), so re-running replays the
 * ledger instead of rerolling dice. Fail open on every path: errors
 * and unparseable responses become pass votes; only a complete,
 * unanimous set of exclude votes moves a record out of screening.
 *
 * mode "live": only untouched records; unanimity flips status to
 * prescreen_excluded. mode "validate": runs the same votes on records
 * humans already screened, changes nothing, and reports what WOULD
 * have happened, so teams can check the pipeline against themselves.
 */

export const maxDuration = 60;

type Body = {
  projectId?: string;
  recordId?: string;
  apiKey?: string;
  model?: string;
  secondApiKey?: string;
  mode?: "live" | "validate";
};

async function callDet(
  model: string,
  apiKey: string,
  system: string,
  user: string
): Promise<{
  text?: string;
  modelVersion?: string;
  error?: string;
  usage?: { inputTokens: number; outputTokens: number };
}> {
  const provider = MODEL_PROVIDERS[model];
  try {
    if (provider === "anthropic") {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model,
          max_tokens: 800,
          temperature: 0,
          system,
          messages: [{ role: "user", content: user }],
        }),
      });
      const data = (await res.json().catch(() => null)) as {
        model?: string;
        content?: { type: string; text?: string }[];
        usage?: { input_tokens?: number; output_tokens?: number };
        error?: { message?: string };
      } | null;
      if (!res.ok) {
        return {
          error:
            res.status === 401
              ? "Invalid Anthropic API key."
              : (data?.error?.message ?? `Anthropic responded ${res.status}`),
        };
      }
      return {
        text: (data?.content ?? [])
          .filter((b) => b.type === "text")
          .map((b) => b.text ?? "")
          .join(""),
        modelVersion: data?.model,
        usage: {
          inputTokens: data?.usage?.input_tokens ?? 0,
          outputTokens: data?.usage?.output_tokens ?? 0,
        },
      };
    }
    // OpenAI; some models reject sampling params, so retry bare once.
    const attempt = async (withDet: boolean) =>
      fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model,
          max_completion_tokens: 800,
          ...(withDet ? { temperature: 0, seed: 42 } : {}),
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
        }),
      });
    let res = await attempt(true);
    if (res.status === 400) {
      const body = await res.clone().text();
      if (/temperature|seed/i.test(body)) res = await attempt(false);
    }
    const data = (await res.json().catch(() => null)) as {
      model?: string;
      system_fingerprint?: string;
      choices?: { message?: { content?: string | null } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
      error?: { message?: string };
    } | null;
    if (!res.ok) {
      return {
        error:
          res.status === 401
            ? "Invalid OpenAI API key."
            : (data?.error?.message ?? `OpenAI responded ${res.status}`),
      };
    }
    return {
      text: data?.choices?.[0]?.message?.content ?? "",
      modelVersion: [data?.model, data?.system_fingerprint]
        .filter(Boolean)
        .join(" "),
      usage: {
        inputTokens: data?.usage?.prompt_tokens ?? 0,
        outputTokens: data?.usage?.completion_tokens ?? 0,
      },
    };
  } catch {
    return { error: `Could not reach the ${provider} API.` };
  }
}

export async function POST(req: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = (await req.json().catch(() => null)) as Body | null;
  const projectId = body?.projectId;
  const recordId = body?.recordId;
  const apiKey = body?.apiKey?.trim();
  const mode = body?.mode === "validate" ? "validate" : "live";
  if (!projectId || !recordId || !apiKey) {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }
  // The prescreen's models are prescribed, never client-chosen: the
  // provider of each relayed key decides, and any model field a stale
  // client sends is ignored. Every project screens with the same
  // instrument, so results stay comparable and reportable.
  const model = apiKey.startsWith("sk-ant-")
    ? "claude-sonnet-5"
    : "gpt-5.6-terra";
  const secondApiKey = body?.secondApiKey?.trim() || null;
  const partner = secondApiKey ? partnerModelFor(model) : null;

  // RLS scopes these reads to the caller's memberships.
  const { data: rec } = await supabase
    .from("records")
    .select("id, title, abstract, status")
    .eq("id", recordId)
    .eq("project_id", projectId)
    .single();
  if (!rec) {
    return NextResponse.json({ error: "record not found" }, { status: 404 });
  }
  const { data: proj } = await supabase
    .from("projects")
    .select("research_question, inclusion_criteria")
    .eq("id", projectId)
    .single();
  // The exclusion criteria ARE the exclusion reasons list: the same
  // E1..En the humans exclude with, so a vote's cited criterion is
  // verifiable against the exact list the team uses.
  const { data: reasonRows } = await supabase
    .from("exclusion_reasons")
    .select("label")
    .eq("project_id", projectId)
    .order("position");
  const exclusionText = (reasonRows ?? [])
    .map((r) => `- ${r.label}`)
    .join("\n");
  if (
    !proj?.research_question?.trim() ||
    !proj?.inclusion_criteria?.trim() ||
    !exclusionText
  ) {
    return NextResponse.json({
      error:
        "The prescreen needs the research question, the inclusion criteria, and at least one exclusion reason recorded before it can judge anything.",
    });
  }

  const { count: taCount } = await supabase
    .from("screening_decisions")
    .select("id", { count: "exact", head: true })
    .eq("record_id", recordId)
    .eq("stage", "title_abstract");
  if (mode === "live" && ((taCount ?? 0) > 0 || rec.status !== "active")) {
    return NextResponse.json({ skipped: "already_screened" });
  }
  // Thin or missing abstracts are judged too (search-net debris like
  // proceedings front matter is often title-only); the decision
  // standard confines title-only judgments to unmistakable cases.

  const criteriaText = `${proj.inclusion_criteria}\n${exclusionText}`;
  const cHash = criteriaHash(
    proj.research_question,
    proj.inclusion_criteria,
    exclusionText
  );
  // Five votes always: all five procedures on one model, or the five
  // split across two models when both provider keys are present.
  const expected: { framing: Framing; model: string; key: string }[] = (
    partner && secondApiKey
      ? [
          ...PRIMARY_DUAL_FRAMINGS.map((f) => ({ f, m: model, k: apiKey })),
          ...PARTNER_FRAMINGS.map((f) => ({ f, m: partner, k: secondApiKey })),
        ]
      : [...FRAMINGS].map((f) => ({ f, m: model, k: apiKey }))
  ).map((x) => ({ framing: x.f, model: x.m, key: x.k }));

  // Reuse the ledger: only compute slots with no stored vote for the
  // current prompt version and criteria hash.
  const { data: stored } = await supabase
    .from("prescreen_votes")
    .select("framing, model, verdict, criterion, evidence, note")
    .eq("record_id", recordId)
    .eq("prompt_version", PRESCREEN_PROMPT_VERSION)
    .eq("criteria_hash", cHash);
  const votes = (stored ?? []) as {
    framing: string;
    model: string;
    verdict: string;
    criterion: string | null;
    evidence: string | null;
    note: string | null;
  }[];
  const missing = expected.filter(
    (e) => !votes.some((v) => v.framing === e.framing && v.model === e.model)
  );

  const runId = crypto.randomUUID();
  // Billed tokens of every FRESH call this evaluation makes, per
  // model, relayed to the client so it can learn a per-record cost
  // average for the estimate (replayed ledger votes cost nothing and
  // report nothing).
  const usage = new Map<string, { inputTokens: number; outputTokens: number }>();
  const addUsage = (
    m: string,
    u?: { inputTokens: number; outputTokens: number }
  ) => {
    if (!u) return;
    const cur = usage.get(m) ?? { inputTokens: 0, outputTokens: 0 };
    cur.inputTokens += u.inputTokens;
    cur.outputTokens += u.outputTokens;
    usage.set(m, cur);
  };
  if (missing.length > 0) {
    // Criteria-blind extraction per model, reused when stored.
    const modelsNeeded = [...new Set(missing.map((m) => m.model))];
    const factsByModel = new Map<string, string | null>();
    await Promise.all(
      modelsNeeded.map(async (m) => {
        const { data: ex } = await supabase
          .from("prescreen_extractions")
          .select("facts")
          .eq("record_id", recordId)
          .eq("model", m)
          .eq("prompt_version", PRESCREEN_PROMPT_VERSION)
          .maybeSingle();
        if (ex?.facts) {
          factsByModel.set(m, JSON.stringify(ex.facts));
          return;
        }
        const key = expected.find((e) => e.model === m)?.key ?? apiKey;
        const call = await callDet(
          m,
          key,
          extractionPrompt(),
          `Title: ${rec.title}\n\nAbstract: ${rec.abstract?.trim() || "(no abstract available)"}`
        );
        addUsage(m, call.usage);
        const facts = call.text ? parseExtraction(call.text) : null;
        factsByModel.set(m, facts);
        if (facts) {
          await supabase.from("prescreen_extractions").upsert(
            {
              project_id: projectId,
              record_id: recordId,
              model: m,
              model_version: call.modelVersion ?? null,
              prompt_version: PRESCREEN_PROMPT_VERSION,
              facts: JSON.parse(facts),
              created_by: user.id,
            },
            { onConflict: "record_id,model,prompt_version", ignoreDuplicates: true }
          );
        }
      })
    );

    const newVotes = await Promise.all(
      missing.map(async (slot) => {
        const call = await callDet(
          slot.model,
          slot.key,
          votePrompt(
            slot.framing,
            proj.research_question,
            proj.inclusion_criteria,
            exclusionText
          ),
          // The facts framing judges the extraction alone (no abstract)
          // when one exists; every other framing sees both.
          slot.framing === "facts" && factsByModel.get(slot.model)
            ? factsUserPrompt(rec.title, factsByModel.get(slot.model)!)
            : voteUserPrompt(
                rec.title,
                rec.abstract,
                factsByModel.get(slot.model) ?? null
              )
        );
        addUsage(slot.model, call.usage);
        // Evidence must be verbatim from the text this voter was shown:
        // title plus abstract normally, title plus extraction for the
        // facts framing (its abstract is withheld by design).
        const shownText =
          slot.framing === "facts" && factsByModel.get(slot.model)
            ? `${rec.title}\n${factsByModel.get(slot.model)}`
            : `${rec.title}\n${rec.abstract ?? ""}`;
        // Fail open: an API error is a pass vote with the error noted.
        const parsed = call.text
          ? parseVote(call.text, criteriaText, shownText)
          : {
              verdict: "pass" as const,
              criterion: null,
              criterionVerified: false,
              evidence: null,
              note: `model call failed (${call.error ?? "empty response"}); counted as pass`,
            };
        return { slot, parsed, modelVersion: call.modelVersion ?? null };
      })
    );
    const rows = newVotes.map(({ slot, parsed, modelVersion }) => ({
      project_id: projectId,
      record_id: recordId,
      framing: slot.framing,
      model: slot.model,
      model_version: modelVersion,
      verdict: parsed.verdict,
      criterion: parsed.criterion,
      criterion_verified: parsed.criterionVerified,
      evidence: parsed.evidence,
      note: parsed.note,
      prompt_version: PRESCREEN_PROMPT_VERSION,
      criteria_hash: cHash,
      run_id: runId,
      created_by: user.id,
    }));
    const { error: insErr } = await supabase
      .from("prescreen_votes")
      .upsert(rows, {
        onConflict: "record_id,framing,model,prompt_version,criteria_hash",
        ignoreDuplicates: true,
      });
    if (insErr) {
      return NextResponse.json({ error: insErr.message });
    }
    rows.forEach((r) =>
      votes.push({
        framing: r.framing,
        model: r.model,
        verdict: r.verdict,
        criterion: r.criterion,
        evidence: r.evidence,
        note: r.note,
      })
    );
  }

  // Removal now takes three independent hurdles: unanimity, agreement
  // on the SAME criterion, and a final adversarial plausibility check.
  let excluded = unanimousExclude(
    votes,
    expected.map((e) => ({ framing: e.framing, model: e.model })),
    criteriaText
  );
  if (excluded) {
    const storedVeto = votes.find((v) => v.framing === "veto");
    if (storedVeto) {
      excluded = storedVeto.verdict === "exclude";
    } else {
      const call = await callDet(
        model,
        apiKey,
        vetoPrompt(
          proj.research_question,
          proj.inclusion_criteria,
          exclusionText
        ),
        voteUserPrompt(rec.title, rec.abstract, null)
      );
      addUsage(model, call.usage);
      // Fail open: a failed or unparseable veto call keeps the record.
      const veto = call.text
        ? parseVeto(call.text)
        : {
            allow: false,
            note: `veto call failed (${call.error ?? "empty response"}); removal vetoed`,
          };
      excluded = veto.allow;
      await supabase.from("prescreen_votes").upsert(
        [
          {
            project_id: projectId,
            record_id: recordId,
            framing: "veto",
            model,
            model_version: call.modelVersion ?? null,
            verdict: veto.allow ? "exclude" : "pass",
            criterion: null,
            criterion_verified: false,
            evidence: null,
            note: veto.note,
            prompt_version: PRESCREEN_PROMPT_VERSION,
            criteria_hash: cHash,
            run_id: runId,
            created_by: user.id,
          },
        ],
        {
          onConflict: "record_id,framing,model,prompt_version,criteria_hash",
          ignoreDuplicates: true,
        }
      );
    }
  }
  if (excluded && mode === "live") {
    const { error: upErr } = await supabase
      .from("records")
      .update({ status: "prescreen_excluded" })
      .eq("id", recordId)
      .eq("status", "active");
    if (upErr) {
      return NextResponse.json({ error: upErr.message });
    }
  }

  return NextResponse.json({
    excluded,
    usage: Object.fromEntries(usage),
    votes: votes.map((v) => ({
      framing: v.framing,
      model: v.model,
      verdict: v.verdict,
      criterion: v.criterion,
      note: v.note,
    })),
  });
}
