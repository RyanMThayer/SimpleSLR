import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { buildAnchor } from "@/lib/anchors";
import { normQuote, parseModelJson, verifyQuote } from "@/lib/aipass";

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

const MODEL = "claude-sonnet-4-5";
const MAX_PAGES = 60;
const MAX_CHARS = 180_000;

type PageRow = { page: number; content: string };

async function extractAllPages(buf: ArrayBuffer): Promise<PageRow[] | null> {
  try {
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
    return out;
  } catch {
    return null;
  }
}

function systemPrompt(): string {
  return [
    "You assist a Webster and Watson style systematic literature review by finding where concepts are evidenced in ONE research paper.",
    "You see only this single paper plus the team's concept vocabulary. Judge evidence strictly from this paper.",
    'Return STRICT JSON only, no prose: {"concepts":[{"label":"...","definition":"...","quotes":[{"page":1,"quote":"...","note":"..."}]}]}',
    "Rules:",
    "- quote MUST be copied verbatim, character for character, from the page it cites (the paper text is labeled [Page N]). Never paraphrase, never merge distant sentences, never invent text.",
    "- A quote is one passage of roughly one to three sentences that clearly evidences the concept.",
    "- When an existing vocabulary concept fits, use its label EXACTLY as given and omit the definition.",
    "- Propose a new concept only when the paper clearly evidences something the vocabulary misses; give it a short label and a one sentence definition.",
    "- Prefer precision over recall: at most a handful of well chosen quotes per concept, and skip concepts with no clear textual evidence.",
    "- note is optional: at most one short sentence on why the quote evidences the concept.",
  ].join("\n");
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
    if (!extracted || extracted.every((p) => !p.content.trim())) {
      return NextResponse.json({
        error:
          "No text layer in this PDF (likely a scan); the AI pass needs selectable text.",
      });
    }
    pages = extracted;
    await supabase.from("record_fulltext").upsert(
      extracted.map((p) => ({
        record_id: recordId,
        project_id: projectId,
        page: p.page,
        content: p.content,
      })),
      { onConflict: "record_id,page" }
    );
  }

  // Concept vocabulary (labels + definitions only; no other papers).
  const { data: conceptRows } = await supabase
    .from("concepts")
    .select("id, label, description")
    .eq("project_id", projectId)
    .order("position");
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

  // One call to Anthropic with the caller's own key.
  let modelText = "";
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 4000,
        system: systemPrompt(),
        messages: [{ role: "user", content: userPrompt }],
      }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const msg =
        (data as { error?: { message?: string } })?.error?.message ??
        `Anthropic responded ${res.status}`;
      return NextResponse.json({
        error: res.status === 401 ? "Invalid API key." : msg,
      });
    }
    modelText = (
      (data as { content?: { type: string; text?: string }[] })?.content ?? []
    )
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("");
  } catch {
    return NextResponse.json({ error: "Could not reach the Anthropic API." });
  }

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

  for (const c of suggestions) {
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
        model: MODEL,
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
