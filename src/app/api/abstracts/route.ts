import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * Authenticated proxy for abstract lookups, keeping third party CORS
 * behavior out of the browser. Both sources are free and keyless:
 * GET  ?doi=...  -> Crossref (raw JATS abstract, stripped client side)
 * POST {ids: [doi, ...]} -> Semantic Scholar batch (plain abstracts)
 */

const UA = "SimpleSLR (https://simple-slr.vercel.app)";

async function requireUser() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user;
}

export async function GET(request: Request) {
  const user = await requireUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { searchParams } = new URL(request.url);
  const doi = searchParams.get("doi");
  if (!doi || doi.length > 300 || doi.includes("..")) {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }
  try {
    const res = await fetch(
      `https://api.crossref.org/works/${encodeURIComponent(doi)}`,
      {
        headers: { "User-Agent": UA, Accept: "application/json" },
        next: { revalidate: 3600 },
      }
    );
    if (!res.ok) {
      // 404 just means Crossref does not know the DOI.
      return NextResponse.json({ abstract: null });
    }
    const body = await res.json();
    const abs = body?.message?.abstract;
    return NextResponse.json({
      abstract: typeof abs === "string" ? abs : null,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "fetch failed" },
      { status: 502 }
    );
  }
}

export async function POST(request: Request) {
  const user = await requireUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const body = await request.json().catch(() => null);
  const ids: unknown = body?.ids;
  if (
    !Array.isArray(ids) ||
    ids.length === 0 ||
    ids.length > 450 ||
    ids.some((x) => typeof x !== "string" || x.length > 300)
  ) {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }
  try {
    const res = await fetch(
      "https://api.semanticscholar.org/graph/v1/paper/batch?fields=abstract",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": UA },
        body: JSON.stringify({ ids: ids.map((d) => `DOI:${d}`) }),
      }
    );
    if (!res.ok) {
      return NextResponse.json(
        { error: `Semantic Scholar responded ${res.status}` },
        { status: 502 }
      );
    }
    const arr = await res.json();
    const results = (Array.isArray(arr) ? arr : []).map((w) =>
      w && typeof w.abstract === "string" && w.abstract.trim()
        ? (w.abstract as string)
        : null
    );
    return NextResponse.json({ results });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "fetch failed" },
      { status: 502 }
    );
  }
}
