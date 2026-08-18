"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { outcomeOf } from "@/lib/outcomes";
import { authorTokens, normalizeDoi, normalizeTitle, sharesAuthor } from "@/lib/normalize";
import {
  fetchCiting,
  fetchReferenced,
  resolveWork,
  shortId,
  workToRef,
  type OaWork,
} from "@/lib/openalex";
import type { ParsedRef, RecordRow } from "@/lib/types";

type Direction = "backward" | "forward";

type Candidate = {
  key: string; // OpenAlex short id
  ref: ParsedRef;
  citedBy: number;
  sources: { seed: string; dir: Direction }[];
  existing: boolean;
  selected: boolean;
};

type CorpusKey = {
  norm_doi: string | null;
  norm_title: string | null;
  authors: string | null;
  year: number | null;
};

export default function SnowballClient({
  projectId,
  userId,
}: {
  projectId: string;
  userId: string;
}) {
  const [seeds, setSeeds] = useState<RecordRow[] | null>(null);
  const [selectedSeeds, setSelectedSeeds] = useState<Set<string>>(new Set());
  const [dirBack, setDirBack] = useState(true);
  const [dirFwd, setDirFwd] = useState(true);
  const [corpus, setCorpus] = useState<CorpusKey[]>([]);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [notes, setNotes] = useState<string[]>([]);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const supabase = createClient();
    // Team level title/abstract includes are the seed pool.
    const taByRecord = new Map<string, { decision: string }[]>();
    for (let from = 0; ; from += 1000) {
      const { data, error: dErr } = await supabase
        .from("screening_decisions")
        .select("record_id, decision")
        .eq("project_id", projectId)
        .eq("stage", "title_abstract")
        .range(from, from + 999);
      if (dErr) {
        setError(dErr.message);
        return;
      }
      (data ?? []).forEach((d) => {
        const list = taByRecord.get(d.record_id) ?? [];
        list.push(d);
        taByRecord.set(d.record_id, list);
      });
      if (!data || data.length < 1000) break;
    }
    const includeIds = [...taByRecord.entries()]
      .filter(([, decs]) => outcomeOf(decs) === "included")
      .map(([id]) => id);
    const recs: RecordRow[] = [];
    for (let i = 0; i < includeIds.length; i += 100) {
      const { data } = await supabase
        .from("records")
        .select("*")
        .eq("status", "active")
        .in("id", includeIds.slice(i, i + 100));
      recs.push(...((data ?? []) as RecordRow[]));
    }
    recs.sort((a, b) => a.title.localeCompare(b.title));
    setSeeds(recs);
    setSelectedSeeds(new Set(recs.map((r) => r.id)));

    // Full corpus keys, for existing-flags and import dedup.
    const keys: CorpusKey[] = [];
    for (let from = 0; ; from += 1000) {
      const { data } = await supabase
        .from("records")
        .select("norm_doi, norm_title, authors, year")
        .eq("project_id", projectId)
        .range(from, from + 999);
      keys.push(...((data ?? []) as CorpusKey[]));
      if (!data || data.length < 1000) break;
    }
    setCorpus(keys);
    setError(null);
  }, [projectId]);

  useEffect(() => {
    // Fetch-on-mount: state updates happen after awaits inside load().
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  async function run() {
    if (!seeds || selectedSeeds.size === 0 || (!dirBack && !dirFwd)) return;
    setRunning(true);
    setResult(null);
    setError(null);
    setCandidates(null);
    const newNotes: string[] = [];
    const map = new Map<string, { work: OaWork; sources: Candidate["sources"] }>();
    const chosen = seeds.filter((s) => selectedSeeds.has(s.id));
    const seedTitles = new Set(
      chosen.map((s) => s.norm_title ?? normalizeTitle(s.title))
    );

    try {
      for (let i = 0; i < chosen.length; i++) {
        const seed = chosen[i];
        const label = seed.title.slice(0, 60);
        setProgress(`Resolving ${i + 1}/${chosen.length}: ${label}...`);
        const work = await resolveWork(seed);
        if (!work) {
          newNotes.push(`Could not resolve in OpenAlex: ${label}`);
          continue;
        }
        const add = (w: OaWork, dir: Direction) => {
          if (!w.id || !w.display_name) return;
          const key = shortId(w.id);
          if (key === shortId(work.id)) return;
          const entry = map.get(key) ?? { work: w, sources: [] };
          entry.sources.push({ seed: label, dir });
          map.set(key, entry);
        };
        if (dirBack) {
          setProgress(`Backward from ${label}...`);
          (await fetchReferenced(work)).forEach((w) => add(w, "backward"));
        }
        if (dirFwd) {
          setProgress(`Forward from ${label}...`);
          const fwd = await fetchCiting(work.id);
          fwd.works.forEach((w) => add(w, "forward"));
          if (fwd.truncated) {
            newNotes.push(
              `${label} has ${fwd.total} citing works; loaded the ${fwd.works.length} most cited.`
            );
          }
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }

    const doiSet = new Set(corpus.map((k) => k.norm_doi).filter(Boolean));
    const titleSet = new Set(corpus.map((k) => k.norm_title).filter(Boolean));
    const list: Candidate[] = [...map.entries()].map(([key, { work, sources }]) => {
      const ref = workToRef(work);
      const nd = normalizeDoi(ref.doi);
      const nt = normalizeTitle(ref.title);
      const existing =
        (nd !== null && doiSet.has(nd)) ||
        (nt !== "" && (titleSet.has(nt) || seedTitles.has(nt)));
      return {
        key,
        ref,
        citedBy: work.cited_by_count ?? 0,
        sources,
        existing,
        selected: false,
      };
    });
    list.sort((a, b) => {
      if (a.existing !== b.existing) return a.existing ? 1 : -1;
      return b.citedBy - a.citedBy;
    });
    setCandidates(list);
    setNotes(newNotes);
    setProgress(null);
    setRunning(false);
  }

  async function importSelected() {
    if (!candidates) return;
    const picked = candidates.filter((c) => c.selected && !c.existing);
    if (picked.length === 0) return;
    setImporting(true);
    setError(null);
    const supabase = createClient();
    const stamp = new Date().toISOString().slice(0, 10);
    const singleSeed =
      selectedSeeds.size === 1 ? [...selectedSeeds][0] : null;

    // Dedup state, corroborated like file imports.
    type TitleInfo = { tokens: Set<string>; year: number | null };
    const existingDois = new Set<string>();
    const titleMap = new Map<string, TitleInfo[]>();
    corpus.forEach((k) => {
      if (k.norm_doi) existingDois.add(k.norm_doi);
      if (k.norm_title) {
        const list = titleMap.get(k.norm_title) ?? [];
        list.push({ tokens: authorTokens(k.authors), year: k.year });
        titleMap.set(k.norm_title, list);
      }
    });

    let imported = 0;
    let duplicates = 0;
    for (const dir of ["backward", "forward"] as Direction[]) {
      const group = picked.filter((c) => c.sources[0].dir === dir);
      if (group.length === 0) continue;
      const origin = dir === "backward" ? "snowball_backward" : "snowball_forward";
      const { data: batch, error: bErr } = await supabase
        .from("import_batches")
        .insert({
          project_id: projectId,
          source_label: `Snowball ${dir} ${stamp}`,
          imported_by: userId,
          origin,
          seed_record_id: singleSeed,
        })
        .select("id")
        .single();
      if (bErr || !batch) {
        setError(bErr?.message ?? "Could not create the snowball batch.");
        setImporting(false);
        return;
      }
      const rows = group.map((c) => {
        const norm_doi = normalizeDoi(c.ref.doi);
        const norm_title = normalizeTitle(c.ref.title);
        const info = { tokens: authorTokens(c.ref.authors), year: c.ref.year };
        const titleDup = (titleMap.get(norm_title) ?? []).some((t) =>
          t.tokens.size > 0 && info.tokens.size > 0
            ? sharesAuthor(t.tokens, info.tokens)
            : t.year !== null && info.year !== null && t.year === info.year
        );
        const isDup = (norm_doi !== null && existingDois.has(norm_doi)) || titleDup;
        if (norm_doi) existingDois.add(norm_doi);
        if (norm_title) {
          const list = titleMap.get(norm_title) ?? [];
          list.push(info);
          titleMap.set(norm_title, list);
        }
        if (isDup) duplicates++;
        else imported++;
        return {
          project_id: projectId,
          batch_id: batch.id,
          title: c.ref.title,
          authors: c.ref.authors,
          year: c.ref.year,
          venue: c.ref.venue,
          abstract: c.ref.abstract,
          doi: c.ref.doi,
          url: c.ref.url,
          source_label: `Snowball ${dir}`,
          status: isDup ? "duplicate" : "active",
          norm_doi,
          norm_title,
        };
      });
      for (let i = 0; i < rows.length; i += 200) {
        const { error: insErr } = await supabase
          .from("records")
          .insert(rows.slice(i, i + 200));
        if (insErr) {
          setError(insErr.message);
          setImporting(false);
          return;
        }
      }
      await supabase
        .from("import_batches")
        .update({ record_count: rows.length })
        .eq("id", batch.id);
    }
    setImporting(false);
    setResult(
      `Imported ${imported + duplicates} snowball record(s): ${imported} new (now in the screening queue), ${duplicates} marked as duplicates.`
    );
    setCandidates(null);
    load();
  }

  const newCount = candidates?.filter((c) => !c.existing).length ?? 0;
  const existingCount = candidates?.filter((c) => c.existing).length ?? 0;
  const selectedCount = candidates?.filter((c) => c.selected && !c.existing).length ?? 0;

  const card =
    "rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900";
  const primaryBtn =
    "rounded-full bg-zinc-900 px-4 py-2 text-sm font-medium text-zinc-50 transition-colors hover:bg-zinc-700 disabled:opacity-40 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-300";
  const ghostBtn =
    "rounded-full border border-zinc-300 px-3 py-1.5 text-xs text-zinc-700 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800";

  return (
    <main className="mx-auto w-full max-w-4xl flex-1 px-6 py-8">
      <h1 className="mb-1 text-2xl font-semibold text-zinc-900 dark:text-zinc-50">
        Snowballing
      </h1>
      <p className="mb-6 text-sm text-zinc-500 dark:text-zinc-400">
        Webster and Watson&apos;s go backward (each paper&apos;s references)
        and go forward (papers citing it), via OpenAlex. Pick seeds, fetch,
        tick the relevant candidates; imports enter the normal screening
        pipeline and count as &quot;identified via other methods&quot; in
        PRISMA. Repeat rounds as newly included papers join the seed pool,
        until nothing new turns up.
      </p>

      {error && (
        <p className="mb-4 rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
          {error}
        </p>
      )}
      {result && (
        <p className="mb-4 rounded-lg border border-emerald-300 bg-emerald-50 px-4 py-3 text-sm text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-200">
          {result}{" "}
          <Link href={`/projects/${projectId}/screen`} className="underline underline-offset-2">
            Go screen them
          </Link>
        </p>
      )}

      <section className={`${card} mb-6`}>
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <h2 className="mr-auto text-lg font-semibold text-zinc-900 dark:text-zinc-50">
            Seeds ({selectedSeeds.size} of {seeds?.length ?? 0})
          </h2>
          <button
            onClick={() => setSelectedSeeds(new Set(seeds?.map((s) => s.id) ?? []))}
            className={ghostBtn}
          >
            All
          </button>
          <button onClick={() => setSelectedSeeds(new Set())} className={ghostBtn}>
            None
          </button>
        </div>
        {seeds === null ? (
          <p className="text-sm text-zinc-500">Loading included records...</p>
        ) : seeds.length === 0 ? (
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            No records are included at title/abstract yet; snowballing starts
            from your included papers.
          </p>
        ) : (
          <div className="mb-3 flex flex-col gap-1">
            {seeds.map((s) => (
              <label
                key={s.id}
                className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-zinc-800 hover:bg-zinc-50 dark:text-zinc-200 dark:hover:bg-zinc-800/50"
              >
                <input
                  type="checkbox"
                  checked={selectedSeeds.has(s.id)}
                  onChange={(e) => {
                    const next = new Set(selectedSeeds);
                    if (e.target.checked) next.add(s.id);
                    else next.delete(s.id);
                    setSelectedSeeds(next);
                  }}
                />
                <span className="min-w-0 flex-1 truncate">{s.title}</span>
                <span className="shrink-0 text-xs text-zinc-400">{s.year ?? ""}</span>
              </label>
            ))}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-4 text-sm text-zinc-700 dark:text-zinc-300">
          <label className="flex items-center gap-1">
            <input
              type="checkbox"
              checked={dirBack}
              onChange={(e) => setDirBack(e.target.checked)}
            />
            Backward (references)
          </label>
          <label className="flex items-center gap-1">
            <input
              type="checkbox"
              checked={dirFwd}
              onChange={(e) => setDirFwd(e.target.checked)}
            />
            Forward (citing papers)
          </label>
          <button
            onClick={run}
            disabled={running || selectedSeeds.size === 0 || (!dirBack && !dirFwd)}
            className={primaryBtn}
          >
            {running ? (progress ?? "Fetching...") : "Fetch candidates"}
          </button>
        </div>
      </section>

      {notes.length > 0 && (
        <ul className="mb-4 flex flex-col gap-1">
          {notes.map((n, i) => (
            <li
              key={i}
              className="rounded-lg bg-amber-50 px-3 py-1.5 text-xs text-amber-800 dark:bg-amber-950 dark:text-amber-200"
            >
              {n}
            </li>
          ))}
        </ul>
      )}

      {candidates !== null && (
        <section className={card}>
          <div className="mb-3 flex flex-wrap items-center gap-3">
            <h2 className="mr-auto text-lg font-semibold text-zinc-900 dark:text-zinc-50">
              Candidates: {newCount} new, {existingCount} already in corpus
            </h2>
            <button
              onClick={() =>
                setCandidates((cs) =>
                  cs?.map((c) => (c.existing ? c : { ...c, selected: true })) ?? cs
                )
              }
              className={ghostBtn}
            >
              Select all new
            </button>
            <button
              onClick={() =>
                setCandidates((cs) => cs?.map((c) => ({ ...c, selected: false })) ?? cs)
              }
              className={ghostBtn}
            >
              Clear
            </button>
          </div>

          <div className="mb-3 flex max-h-[60vh] flex-col gap-1 overflow-y-auto">
            {candidates.map((c) => (
              <label
                key={c.key}
                className={`flex items-start gap-2 rounded-lg px-2 py-1.5 text-sm ${
                  c.existing
                    ? "opacity-45"
                    : "hover:bg-zinc-50 dark:hover:bg-zinc-800/50"
                }`}
              >
                <input
                  type="checkbox"
                  className="mt-1"
                  disabled={c.existing}
                  checked={c.selected}
                  onChange={(e) =>
                    setCandidates(
                      (cs) =>
                        cs?.map((x) =>
                          x.key === c.key ? { ...x, selected: e.target.checked } : x
                        ) ?? cs
                    )
                  }
                />
                <span className="min-w-0 flex-1">
                  <span className="block text-zinc-900 dark:text-zinc-50">
                    {c.ref.title}
                  </span>
                  <span className="block truncate text-xs text-zinc-500 dark:text-zinc-400">
                    {[c.ref.authors, c.ref.year, c.ref.venue]
                      .filter(Boolean)
                      .join(" · ")}
                    {" · cited by "}
                    {c.citedBy}
                  </span>
                </span>
                <span className="flex shrink-0 gap-1">
                  {[...new Set(c.sources.map((s) => s.dir))].map((d) => (
                    <span
                      key={d}
                      title={c.sources
                        .filter((s) => s.dir === d)
                        .map((s) => `${d} from: ${s.seed}`)
                        .join("\n")}
                      className={`rounded-full px-2 py-0.5 text-xs ${
                        d === "backward"
                          ? "bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300"
                          : "bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300"
                      }`}
                    >
                      {d === "backward" ? "B" : "F"}
                    </span>
                  ))}
                  {c.existing && (
                    <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
                      in corpus
                    </span>
                  )}
                </span>
              </label>
            ))}
          </div>

          <button
            onClick={importSelected}
            disabled={importing || selectedCount === 0}
            className={primaryBtn}
          >
            {importing ? "Importing..." : `Import ${selectedCount} selected`}
          </button>
        </section>
      )}
    </main>
  );
}
