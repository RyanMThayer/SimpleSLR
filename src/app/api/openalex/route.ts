import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * Thin authenticated proxy for the OpenAlex works API, so browser code
 * never depends on OpenAlex CORS behavior. Only /works requests pass
 * through. OpenAlex is free and keyless; see docs.openalex.org.
 */
export async function GET(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const u = searchParams.get("u");
  if (!u || !/^works(\/|\?|$)/.test(u) || u.includes("..")) {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }

  try {
    const res = await fetch(`https://api.openalex.org/${u}`, {
      headers: { Accept: "application/json" },
      // OpenAlex data changes slowly; a short cache softens rate limits.
      next: { revalidate: 300 },
    });
    const body = await res.json();
    return NextResponse.json(body, { status: res.status });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "fetch failed" },
      { status: 502 }
    );
  }
}
