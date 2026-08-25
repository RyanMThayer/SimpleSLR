import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { installPdfNodeShims } from "@/lib/pdfNodeShims";

/**
 * Fetch an open access PDF (url from OpenAlex OA locations) on the
 * server, optionally store it as the record's full text, and optionally
 * return the first pages' text for abstract extraction. The PDF itself
 * never travels back to the browser, which keeps responses small.
 *
 * POST { url, projectId, recordId, attach, extract }
 *  -> { attached?: boolean, page1?: string | null, error?: string }
 */

export const maxDuration = 60;

const MAX_BYTES = 45 * 1024 * 1024;

function urlAllowed(raw: string): boolean {
  if (raw.length > 1000) return false;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false;
  const host = u.hostname.toLowerCase();
  if (!host.includes(".")) return false;
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(host)) return false;
  if (host === "localhost" || host.endsWith(".local") || host.startsWith("[")) {
    return false;
  }
  return true;
}

async function extractFirstPagesText(buf: ArrayBuffer): Promise<string | null> {
  try {
    installPdfNodeShims();
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const task = pdfjs.getDocument({
      data: new Uint8Array(buf),
      disableFontFace: true,
      useSystemFonts: true,
    });
    const doc = await task.promise;
    const pages = Math.min(2, doc.numPages);
    let text = "";
    for (let p = 1; p <= pages; p++) {
      const page = await doc.getPage(p);
      const tc = await page.getTextContent();
      text +=
        tc.items
          .map((it) => ("str" in it ? it.str : ""))
          .join(" ") + " ";
    }
    await task.destroy();
    return text.trim() || null;
  } catch {
    return null;
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
  const url: unknown = body?.url;
  const projectId: unknown = body?.projectId;
  const recordId: unknown = body?.recordId;
  const attach = body?.attach === true;
  const extract = body?.extract === true;
  if (
    typeof url !== "string" ||
    !urlAllowed(url) ||
    typeof projectId !== "string" ||
    typeof recordId !== "string" ||
    (!attach && !extract)
  ) {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }

  let buf: ArrayBuffer;
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "SimpleSLR (https://simple-slr.vercel.app)",
        Accept: "application/pdf,*/*",
      },
      cache: "no-store",
    });
    if (!res.ok) {
      return NextResponse.json({ error: `source responded ${res.status}` });
    }
    const len = Number(res.headers.get("content-length") ?? 0);
    if (len > MAX_BYTES) {
      return NextResponse.json({ error: "PDF larger than 45 MB" });
    }
    buf = await res.arrayBuffer();
  } catch (e) {
    return NextResponse.json({
      error: e instanceof Error ? e.message : "download failed",
    });
  }
  if (buf.byteLength > MAX_BYTES) {
    return NextResponse.json({ error: "PDF larger than 45 MB" });
  }
  const head = new TextDecoder().decode(new Uint8Array(buf.slice(0, 5)));
  if (head !== "%PDF-") {
    return NextResponse.json({ error: "not a PDF" });
  }

  let attached = false;
  if (attach) {
    // Storage and record policies enforce project membership; a
    // non-member's upload or update simply fails.
    const path = `${projectId}/${recordId}.pdf`;
    const { error: upErr } = await supabase.storage
      .from("fulltexts")
      .upload(path, buf, { upsert: true, contentType: "application/pdf" });
    if (!upErr) {
      const { error: recErr } = await supabase
        .from("records")
        .update({ fulltext_path: path, retrieval_status: null })
        .eq("id", recordId)
        .eq("project_id", projectId);
      attached = !recErr;
    }
  }

  const page1 = extract ? await extractFirstPagesText(buf) : null;
  return NextResponse.json({ attached, page1 });
}
