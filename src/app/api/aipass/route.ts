import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { buildAnchor } from "@/lib/anchors";
import { normQuote, parseModelJson, verifyQuote } from "@/lib/aipass";
import { installPdfNodeShims } from "@/lib/pdfNodeShims";

/**
 * The AI concept pass: one paper, one call. Downloads the stored PDF,
 * extracts (and caches) per page text, asks the model for concept
 * suggestions with verbatim quotes, verifies every quote against the
 * real page text, anchors the survivors, and inserts them as PENDING
 * rows in concept_suggestions. Nothing touches concepts, tags, or
 * excerpts until a member accepts a suggestion in the reading room.
 *
 * The caller's Anthropic API key is relayed to api.anthropic.com for
 * this one request and never stored or logged. All database access
 * runs under the caller's own session, so RLS enforces membership.
 *
 * POST { projectId, recordId, apiKey }
 *  -> { suggested, droppedUnverified, droppedDuplicate, pages, truncated?, error? }
 */

export const maxDuration = 60;

/** Allowed models; the key the user supplies must match the provider. */
const MODELS: Record<string, "anthropic" | "openai"> = {
  "claude-sonnet-5": "anthropic",
  "claude-opus-5": "anthropic",
  "gpt-5.6-terra": "openai",
  "gpt-5.6-luna": "openai",
};
const DEFAULT_MODEL = "claude-sonnet-5";
const MAX_PAGES = 60;
const MAX_CHARS = 180_000;

type PageRow = { page: number; content: string };

async function extractAllPages(
  buf: ArrayBuffer
): Promise<{ pages: PageRow[] } | { failure: string }> {
  try {
    installPdfNodeShims();
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const task = pdfjs.getDocument({
      data: new Uint8Array(buf),
      disableFontFace: true,
      useSystemFonts: true,
    });
    const doc = await task.promise;
    const out: PageRow[] = [];
    const pages = Math.min(doc.numPages, MAX_PAGES);
    for (let p = 1; p <= pages; p++) {
      const page = await doc.getPage(p);
      const tc = await page.getTextContent();
      // IMPORTANT: joined with no separator, matching the reading
      // room's text layer concatenation, so anchors line up client side.
      const content = tc.items
        .map((it) => ("str" in it ? it.str : ""))
        .join("");
      out.push({ page: p, content });
    }
    await task.destroy();
    return { pages: out };
  } catch (e) {
    // Surface the real cause: an extraction CRASH is a server problem,
    // not a scanned PDF, and conflating them hid a production bug.
    console.error("aipass: pdf extraction failed:", e);
    return { failure: e instanceof Error ? e.message : String(e) };
  }
}

function systemPrompt(rq: string | null, criteria: string | null): string {
  return [
    "You assist a Webster and Watson style literature review. The team builds a concept matrix: rows are papers, columns are CONCEPTS, and a checkmark means a paper evidences that concept.",
    "Work from this ONE paper alone. Your job: find where it evidences existing vocabulary concepts, and propose new concepts only when nothing in the vocabulary fits even loosely.",
    "",
    `Research question of the review: ${rq?.trim() || "(not recorded)"}`,
    `Inclusion criteria: ${criteria?.trim() || "(not recorded)"}`,
    "",
    "What makes a good concept (a matrix column):",
    "- A broad, reusable theme, mechanism, method family, or outcome, named in 1 to 4 words. It must pass this test: a DIFFERENT paper in this review could plausibly also earn a checkmark for it. Aim the granularity at the level of the research question above.",
    "- Keep specificity in the quotes, not in the concept name; several specific quotes gathered under one broad concept is acceptable and encouraged.",
    "",
    "Budget: at most 8 concepts for this paper. If you find more themes, group them under broader concepts until they fit the budget.",
    "",
    'Return STRICT JSON only, no prose: {"concepts":[{"matched":"...","label":"...","definition":"...","breadth_note":"...","quotes":[{"page":1,"quote":"...","note":"..."}]}]}',
    "Rules:",
    '- "matched": the EXACT label of the existing vocabulary concept this evidence belongs to, or "new" only when none fits. Prefer matching.',
    '- "label": the concept name (the existing label verbatim when matched; your new 1 to 4 word name otherwise).',
    '- "definition": one sentence, new concepts only.',
    '- "breadth_note": one sentence on how a DIFFERENT paper could evidence this concept. If you cannot write one, the concept is too specific: broaden it or drop it.',
    "- quotes: 1 to 5 passages per concept, each copied verbatim, character for character, from the page it cites (the paper text is labeled [Page N]). Never paraphrase, never merge distant sentences, never invent text. A quote is roughly one to three sentences.",
    '- "note" on a quote is optional: one short sentence on why it evidences the concept.',
  ].join("\n");
}

/** One model call; returns the response text or an error message. */
async function callModel(
  model: string,
  apiKey: string,
  system: string,
  userPrompt: string
): Promise<{ text?: string; error?: string }> {
  const provider = MODELS[model];
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
          max_tokens: 8000,
          system,
          messages: [{ role: "user", content: userPrompt }],
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        const msg =
          (data as { error?: { message?: string } })?.error?.message ??
          `Anthropic responded ${res.status}`;
        return { error: res.status === 401 ? "Invalid Anthropic API key." : msg };
      }
      const text = (
        (data as { content?: { type: string; text?: string }[] })?.content ?? []
      )
        .filter((b) => b.type === "text")
        .map((b) => b.text ?? "")
        .join("");
      return { text };
    }
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        max_completion_tokens: 8000,
        messages: [
          { role: "system", content: system },
          { role: "user", content: userPrompt },
        ],
      }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const msg =
        (data as { error?: { message?: string } })?.error?.message ??
        `OpenAI responded ${res.status}`;
      return { error: res.status === 401 ? "Invalid OpenAI API key." : msg };
    }
    const text =
      (
        data as {
          choices?: { message?: { content?: string | null } }[];
        }
      )?.choices?.[0]?.message?.content ?? "";
    return { text };
  } catch {
    return { error: `Could not reach the ${provider} API.` };
  }
}

export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const projectId: unknown = body?.projectId;
  const recordId: unknown = body?.recordId;
  const apiKey: unknown = body?.apiKey;
  const model =
    typeof body?.model === "string" && body.model in MODELS
      ? (body.model as string)
      : DEFAULT_MODEL;
  if (
    typeof projectId !== "string" ||
    typeof recordId !== "string" ||
    typeof apiKey !== "string" ||
    apiKey.length < 8 ||
    apiKey.length > 300
  ) {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }

  // The record (RLS: only members can see it).
  const { data: rec, error: recErr } = await supabase
    .from("records")
    .select("id, project_id, title, fulltext_path")
    .eq("id", recordId)
    .eq("project_id", projectId)
    .single();
  if (recErr || !rec) {
    return NextResponse.json({ error: "record not found" }, { status: 404 });
  }
  if (!rec.fulltext_path) {
    return NextResponse.json({ error: "This record has no PDF attached." });
  }

  // Page text: cached, or extracted now and cached.
  let pages: PageRow[] = [];
  const { data: cached, error: cacheErr } = await supabase
    .from("record_fulltext")
    .select("page, content")
    .eq("record_id", recordId)
    .order("page");
  if (cacheErr) {
    return NextResponse.json({
      error: cacheErr.message.includes("does not exist")
        ? "Run migration 0016_ai_pass.sql in the Supabase SQL Editor first."
        : cacheErr.message,
    });
  }
  if (cached && cached.length > 0) {
    pages = cached as PageRow[];
  } else {
    const { data: blob, error: dlErr } = await supabase.storage
      .from("fulltexts")
      .download(rec.fulltext_path);
    if (dlErr || !blob) {
      return NextResponse.json({ error: "Could not download the PDF." });
    }
    const extracted = await extractAllPages(await blob.arrayBuffer());
    if ("failure" in extracted) {
      return NextResponse.json({
        error: `PDF text extraction failed on the server (${extracted.failure}). This is a server problem, not your PDF.`,
      });
    }
    if (extracted.pages.every((p) => !p.content.trim())) {
      return NextResponse.json({
        error:
          "No text layer in this PDF (likely a scan); the AI pass needs selectable text.",
      });
    }
    pages = extracted.pages;
    await supabase.from("record_fulltext").upsert(
      extracted.pages.map((p) => ({
        record_id: recordId,
        project_id: projectId,
        page: p.page,
        content: p.content,
      })),
      { onConflict: "record_id,page" }
    );
  }

  // Concept vocabulary (labels + definitions only; no other papers),
  // plus the review's framing so granularity lands at the level of the
  // research question.
  const [{ data: conceptRows }, { data: proj }] = await Promise.all([
    supabase
      .from("concepts")
      .select("id, label, description")
      .eq("project_id", projectId)
      .order("position"),
    supabase
      .from("projects")
      .select("research_question, inclusion_criteria")
      .eq("id", projectId)
      .single(),
  ]);
  const concepts = conceptRows ?? [];

  // Assemble the paper text, truncating very long documents.
  let total = 0;
  let truncated = false;
  const paperParts: string[] = [];
  for (const p of pages) {
    if (total >= MAX_CHARS) {
      truncated = true;
      break;
    }
    const room = MAX_CHARS - total;
    const content =
      p.content.length > room ? p.content.slice(0, room) : p.content;
    if (content.length < p.content.length) truncated = true;
    paperParts.push(`[Page ${p.page}]\n${content}`);
    total += content.length;
  }

  const vocab =
    concepts.length > 0
      ? concepts
          .map(
            (c) => `- ${c.label}${c.description ? `: ${c.description}` : ""}`
          )
          .join("\n")
      : "(none yet - propose the concepts this paper evidences)";

  const userPrompt = `Existing concept vocabulary:\n${vocab}\n\nPaper title: ${rec.title}\n\n${paperParts.join("\n\n")}`;

  // One call to the chosen provider with the caller's own key.
  const call = await callModel(
    model,
    apiKey,
    systemPrompt(proj?.research_question ?? null, proj?.inclusion_criteria ?? null),
    userPrompt
  );
  if (call.error || !call.text) {
    return NextResponse.json({
      error: call.error ?? "The model returned an empty response.",
    });
  }
  const modelText = call.text;

  const suggestions = parseModelJson(modelText);
  if (!suggestions) {
    return NextResponse.json({
      error: "The model returned no parseable suggestions; try again.",
    });
  }

  // Existing quotes on this record (excerpts + any prior suggestions)
  // so re-runs and AI/human overlap never duplicate.
  const seen = new Set<string>();
  const { data: exRows } = await supabase
    .from("concept_excerpts")
    .select("quote")
    .eq("record_id", recordId);
  (exRows ?? []).forEach((r) => seen.add(normQuote(r.quote)));
  const { data: sugRows } = await supabase
    .from("concept_suggestions")
    .select("quote")
    .eq("record_id", recordId);
  (sugRows ?? []).forEach((r) => seen.add(normQuote(r.quote)));

  const byLabel = new Map(
    concepts.map((c) => [c.label.trim().toLowerCase(), c.id])
  );
  const pageMap = new Map(pages.map((p) => [p.page, p.content]));
  const runId = crypto.randomUUID();
  const rows: Record<string, unknown>[] = [];
  let droppedUnverified = 0;
  let droppedDuplicate = 0;

  // Budget enforced server side too: the prompt asks for at most 8,
  // and anything past 10 is dropped rather than flooding the review.
  for (const c of suggestions.slice(0, 10)) {
    const conceptId = byLabel.get(c.label.trim().toLowerCase()) ?? null;
    for (const q of c.quotes) {
      const pageText = pageMap.get(q.page);
      const hit = pageText ? verifyQuote(pageText, q.quote) : null;
      if (!hit || !pageText) {
        droppedUnverified++;
        continue;
      }
      const anchor = buildAnchor(pageText, hit.start, hit.end);
      if (!anchor) {
        droppedUnverified++;
        continue;
      }
      const key = normQuote(anchor.quote);
      if (seen.has(key)) {
        droppedDuplicate++;
        continue;
      }
      seen.add(key);
      rows.push({
        project_id: projectId,
        record_id: recordId,
        run_id: runId,
        concept_id: conceptId,
        concept_label: c.label,
        definition: conceptId ? null : (c.definition ?? null),
        quote: anchor.quote,
        page: q.page,
        pos_start: anchor.pos_start,
        pos_end: anchor.pos_end,
        prefix: anchor.prefix,
        suffix: anchor.suffix,
        note: q.note ?? null,
        model,
        created_by: user.id,
      });
    }
  }

  if (rows.length > 0) {
    const { error: insErr } = await supabase
      .from("concept_suggestions")
      .insert(rows);
    if (insErr) {
      return NextResponse.json({ error: insErr.message });
    }
  }

  return NextResponse.json({
    suggested: rows.length,
    droppedUnverified,
    droppedDuplicate,
    pages: pages.length,
    truncated,
  });
}
