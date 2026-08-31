"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import type { Project } from "@/lib/types";

type ProjectWithStats = Project & {
  recordCount: number;
  myDone: number;
};

export default function DashboardClient({ userId }: { userId: string }) {
  const router = useRouter();
  const [projects, setProjects] = useState<ProjectWithStats[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [showJoin, setShowJoin] = useState(false);
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  // A freshly minted sign in token can be rejected for a short window
  // (clock skew between Supabase's auth and data services). The fetch
  // layer already absorbs small skews; this counter keeps retrying
  // quietly on the landing page if the window is longer, so users see
  // "Loading..." instead of a raw JWT error right after signing in.
  const jwtRetries = useRef(0);
  const [retryTick, setRetryTick] = useState(0);

  const load = useCallback(async () => {
    const supabase = createClient();
    // Email invites are claimed at sign-in: any project that invited
    // this address joins here, before the list loads. Best effort; the
    // function is absent before migration 0022.
    try {
      await supabase.rpc("claim_project_invites");
    } catch {
      // Nothing to claim.
    }
    const { data, error } = await supabase
      .from("projects")
      .select("*")
      .order("created_at", { ascending: false });
    if (error) {
      if (/\bjwt\b/i.test(error.message) && jwtRetries.current < 10) {
        jwtRetries.current += 1;
        setTimeout(() => setRetryTick((t) => t + 1), 2500);
        return;
      }
      setError(
        error.message.includes("does not exist") ||
          error.message.includes("schema cache")
          ? "The database schema is missing. Run supabase/migrations/0001_phase1.sql in the Supabase SQL Editor, then reload."
          : /\bjwt\b/i.test(error.message)
            ? "Your sign in has not finished settling in, which can take a moment right after a password change. Try reloading; if it keeps happening, sign out and back in."
            : error.message
      );
      setProjects([]);
      return;
    }
    jwtRetries.current = 0;
    const withStats: ProjectWithStats[] = await Promise.all(
      (data as Project[]).map(async (p) => {
        const [records, done] = await Promise.all([
          supabase
            .from("records")
            .select("id", { count: "exact", head: true })
            .eq("project_id", p.id)
            .eq("status", "active"),
          // Inner join onto records so decisions on records that were
          // later marked duplicates never count: done can then not
          // exceed the live record total (the 104/103 dashboard bug).
          supabase
            .from("screening_decisions")
            .select("id, records!inner(id)", { count: "exact", head: true })
            .eq("project_id", p.id)
            .eq("stage", "title_abstract")
            .eq("decided_by", userId)
            .eq("records.status", "active"),
        ]);
        return {
          ...p,
          recordCount: records.count ?? 0,
          myDone: done.count ?? 0,
        };
      })
    );
    setProjects(withStats);
  }, [userId]);

  useEffect(() => {
    // Fetch on mount, and again on each scheduled JWT skew retry;
    // state updates happen after awaits inside load().
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load, retryTick]);

  async function createProject(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const supabase = createClient();
    const { data, error } = await supabase.rpc("create_project", {
      p_name: name,
    });
    setBusy(false);
    if (error) {
      setError(error.message);
      return;
    }
    router.push(`/projects/${data}`);
  }

  async function joinProject(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const supabase = createClient();
    const { data, error } = await supabase.rpc("join_project_by_code", {
      p_code: code,
    });
    setBusy(false);
    if (error) {
      setError(
        error.message.includes("invalid invite code")
          ? "That invite code does not match any project."
          : error.message
      );
      return;
    }
    router.push(`/projects/${data}`);
  }

  const inputCls =
    "h-10 w-full rounded-lg border border-zinc-300 bg-white px-3 text-sm text-zinc-900 outline-none focus:border-teal-600 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50";
  const primaryBtn =
    "rounded-full bg-teal-700 px-4 py-2 text-sm font-medium text-zinc-50 transition-colors hover:bg-teal-800 disabled:opacity-50 dark:bg-teal-400 dark:text-teal-950 dark:hover:bg-teal-300";
  const ghostBtn =
    "rounded-full border border-zinc-300 px-4 py-2 text-sm text-zinc-700 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800";

  return (
    <main className="mx-auto w-full max-w-4xl flex-1 px-6 py-8">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-50">
          Your reviews
        </h1>
        <div className="flex gap-2">
          <button className={ghostBtn} onClick={() => { setShowJoin(!showJoin); setShowCreate(false); }}>
            Join with code
          </button>
          <button className={primaryBtn} onClick={() => { setShowCreate(!showCreate); setShowJoin(false); }}>
            New review
          </button>
        </div>
      </div>

      {showCreate && (
        <form onSubmit={createProject} className="mb-6 flex gap-2">
          <input
            className={inputCls}
            placeholder="Review name, e.g. E-government benchmarking SLR"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            autoFocus
          />
          <button className={primaryBtn} disabled={busy} type="submit">
            Create
          </button>
        </form>
      )}

      {showJoin && (
        <form onSubmit={joinProject} className="mb-6 flex gap-2">
          <input
            className={inputCls}
            placeholder="Invite code from a teammate"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            required
            autoFocus
          />
          <button className={primaryBtn} disabled={busy} type="submit">
            Join
          </button>
        </form>
      )}

      {error && (
        <p className="mb-4 rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
          {error}
        </p>
      )}

      {projects === null ? (
        <p className="text-zinc-600 dark:text-zinc-400">Loading...</p>
      ) : projects.length === 0 && !error ? (
        <p className="text-zinc-600 dark:text-zinc-400">
          No reviews yet. Create one, or join a teammate&apos;s review with
          their invite code.
        </p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {projects.map((p) => (
            <Link
              key={p.id}
              href={`/projects/${p.id}`}
              className="rounded-xl border border-zinc-200 bg-white p-5 transition-colors hover:border-zinc-400 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-zinc-600"
            >
              <h2 className="mb-1 font-semibold text-zinc-900 dark:text-zinc-50">
                {p.name}
              </h2>
              <p className="text-sm text-zinc-600 dark:text-zinc-400">
                {p.recordCount} records
                {p.recordCount > 0 && (
                  <>
                    {" "}
                    · you screened {p.myDone} (
                    {Math.round((p.myDone / p.recordCount) * 100)}%)
                  </>
                )}
              </p>
            </Link>
          ))}
        </div>
      )}
    </main>
  );
}
