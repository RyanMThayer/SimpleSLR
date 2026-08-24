"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { outcomeOf } from "@/lib/outcomes";
import { authorTokens, normalizeDoi, normalizeTitle, sharesAuthor } from "@/lib/normalize";
import { parseRis } from "@/lib/ris";
import { parseBibtex } from "@/lib/bibtex";
import { parseCsv, guessMapping, rowsToRefs } from "@/lib/csv";
import {
  fetchCiting,
  fetchReferenced,
  resolveWork,
  shortId,
  workKind,
  workToRef,
  type OaWork,
} from "@/lib/openalex";
import { findMissingAbstracts, plausibleAbstract } from "@/lib/abstracts";
import type { ParsedRef, RecordRow } from "@/lib/types";

type Direction = "backward" | "forward";

type Candidate = {
  key: string; // OpenAlex short id
  ref: ParsedRef;
  citedBy: number;
  /** Probable non journal-article kind ("preprint", "report", ...). */
  kind: string | null;
  sources: { seedId: string; seed: string; dir: Direction }[];
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
  const [fwdNewest, setFwdNewest] = useState(true);
  const [candSort, setCandSort] = useState<"year" | "cited">("year");
  const [corpus, setCorpus] = useState<CorpusKey[]>([]);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [notes, setNotes] = useState<string[]>([]);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Per seed file import (Scopus / WoS references or cited-by exports)
  const [fileSeed, setFileSeed] = useState<RecordRow | null>(null);
  const [fiDir, setFiDir] = useState<Direction>("backward");
  const [fiRefs, setFiRefs] = useState<ParsedRef[] | null>(null);
  const [fiName, setFiName] = useState("");
  const [fiError, setFiError] = useState<string | null>(null);
  const [fiBusy, setFiBusy] = useState(false);
  const fiInputRef = useRef<HTMLInputElement | null>(null);

  const load = useCallback(async () => {
    const supabase = createClient();
    // Webster and Watson: the seed pool is the included set, meaning
    // papers that survived full text screening, not everything that
    // merely passed title/abstract.
    const byStage = async (stage: string) => {
      const map = new Map<string, { decision: string }[]>();
      for (let from = 0; ; from += 1000) {
        const { data, error: dErr } = await supabase
          .from("screening_decisions")
          .select("record_id, decision")
          .eq("project_id", projectId)
          .eq("stage", stage)
          .range(from, from + 999);
        if (dErr) throw new Error(dErr.message);
        (data ?? []).forEach((d) => {
          const list = map.get(d.record_id) ?? [];
          list.push(d);
          map.set(d.record_id, list);
        });
        if (!data || data.length < 1000) break;
      }
      return map;
    };
    let includeIds: string[];
    try {
      const taByRecord = await byStage("title_abstract");
      const ftByRecord = await byStage("full_text");
      const taIncluded = new Set(
        [...taByRecord.entries()]
          .filter(([, decs]) => outcomeOf(decs) === "included")
          .map(([id]) => id)
      );
      includeIds = [...ftByRecord.entries()]
        .filter(
          ([id, decs]) => taIncluded.has(id) && outcomeOf(decs) === "included"
        )
        .map(([id]) => id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return;
    }
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
          entry.sources.push({ seedId: seed.id, seed: label, dir });
          map.set(key, entry);
        };
        if (dirBack) {
          setProgress(`Backward from ${label}...`);
          const refs = await fetchReferenced(work);
          refs.forEach((w) => add(w, "backward"));
          newNotes.push(
            `Backward from ${label}: ${work.referenced_works?.length ?? refs.length} references, ${refs.length} resolvable in OpenAlex.`
          );
        }
        if (dirFwd) {
          setProgress(`Forward from ${label}...`);
          const fwd = await fetchCiting(work.id, { newestFirst: fwdNewest });
          fwd.works.forEach((w) => add(w, "forward"));
          newNotes.push(
            `Forward from ${label}: ${fwd.total} citing works in OpenAlex${
              fwd.truncated
                ? `; loaded the ${fwd.works.length} ${fwdNewest ? "newest" : "most cited"}`
                : ""
            }.`
          );
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
        kind: workKind(work),
        sources,
        existing,
        // Everything new starts selected: the default path is to import
        // all candidates and let formal screening decide.
        selected: !existing,
      };
    });
    setCandidates(list);
    setNotes(newNotes);
    setProgress(null);
    setRunning(false);
  }

  async function onRefFilePicked(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setFiError(null);
    setFiRefs(null);
    setFiName(file.name);
    const text = await file.text();
    const lower = file.name.toLowerCase();
    let refs: ParsedRef[] = [];
    if (lower.endsWith(".csv") || lower.endsWith(".tsv")) {
      const rows = parseCsv(
        lower.endsWith(".tsv") ? text.replace(/\t/g, ",") : text
      );
      if (rows.length >= 2) {
        const guessed = guessMapping(rows[0]);
        if (guessed.title === null) {
          setFiError(
            "Could not find a title column in this CSV automatically; export RIS instead."
          );
          return;
        }
        refs = rowsToRefs(rows.slice(1), guessed);
      }
    } else if (lower.endsWith(".bib") || lower.endsWith(".bibtex")) {
      refs = parseBibtex(text);
    } else {
      refs = parseRis(text);
    }
    if (refs.length === 0) {
      setFiError(
        "No records found. Expected a RIS, BibTeX, or CSV export from the database."
      );
      return;
    }
    setFiRefs(refs);
  }

  /**
   * Import a references (backward) or cited-by (forward) file export
   * for one seed. Same pipeline as OpenAlex candidates: origin tagged
   * batch, per seed provenance links, corroborated dedup, abstract
   * plausibility guard, automatic enrichment.
   */
  async function importFileRefs() {
    const seed = fileSeed;
    if (!seed || !fiRefs || fiRefs.length === 0 || fiBusy) return;
    setFiBusy(true);
    setError(null);
    const supabase = createClient();
    const stamp = new Date().toISOString().slice(0, 10);
    const origin =
      fiDir === "backward" ? "snowball_backward" : "snowball_forward";
    const { data: batch, error: bErr } = await supabase
      .from("import_batches")
      .insert({
        project_id: projectId,
        source_label: `Snowball ${fiDir} file ${stamp}`,
        filename: fiName,
        imported_by: userId,
        origin,
        seed_record_id: seed.id,
      })
      .select("id")
      .single();
    if (bErr || !batch) {
      setError(bErr?.message ?? "Could not create the import batch.");
      setFiBusy(false);
      return;
    }

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
    let linksMissing = false;
    const rows = fiRefs.map((ref) => {
      const norm_doi = normalizeDoi(ref.doi);
      const norm_title = normalizeTitle(ref.title);
      const info = { tokens: authorTokens(ref.authors), year: ref.year };
      const titleDup = (titleMap.get(norm_title) ?? []).some((t) =>
        t.tokens.size > 0 && info.tokens.size > 0
          ? sharesAuthor(t.tokens, info.tokens)
          : t.year !== null && info.year !== null && t.year === info.year
      );
      const isDup =
        (norm_doi !== null && existingDois.has(norm_doi)) || titleDup;
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
        title: ref.title,
        authors: ref.authors,
        year: ref.year,
        venue: ref.venue,
        abstract: plausibleAbstract(ref.abstract) ? ref.abstract : null,
        doi: ref.doi,
        url: ref.url,
        source_label: `Snowball ${fiDir}`,
        status: isDup ? "duplicate" : "active",
        norm_doi,
        norm_title,
      };
    });
    const newActive: {
      id: string;
      title: string;
      abstract: string | null;
      doi: string | null;
      norm_doi: string | null;
      norm_title: string | null;
    }[] = [];
    for (let i = 0; i < rows.length; i += 200) {
      const { data: inserted, error: insErr } = await supabase
        .from("records")
        .insert(rows.slice(i, i + 200))
        .select("id");
      if (insErr) {
        setError(insErr.message);
        setFiBusy(false);
        return;
      }
      (inserted ?? []).forEach((row, j) => {
        const src = rows[i + j];
        if (!src || src.status !== "active") return;
        newActive.push({
          id: row.id,
          title: src.title,
          abstract: src.abstract,
          doi: src.doi,
          norm_doi: src.norm_doi,
          norm_title: src.norm_title,
        });
      });
      const linkRows = (inserted ?? []).map((row) => ({
        project_id: projectId,
        record_id: row.id,
        seed_record_id: seed.id,
        direction: fiDir,
      }));
      if (linkRows.length > 0) {
        const { error: lkErr } = await supabase
          .from("snowball_links")
          .insert(linkRows);
        if (lkErr && lkErr.message.includes("does not exist")) {
          linksMissing = true;
        } else if (lkErr) {
          setError(lkErr.message);
        }
      }
    }
    await supabase
      .from("import_batches")
      .update({ record_count: rows.length })
      .eq("id", batch.id);
    await supabase
      .from("import_batches")
      .update({ raw_hit_count: fiRefs.length })
      .eq("id", batch.id);

    let absNote = "";
    const missingAbs = newActive.filter((r) => !plausibleAbstract(r.abstract));
    if (missingAbs.length > 0) {
      try {
        setProgress("Fetching missing abstracts for the imported records...");
        const { updates } = await findMissingAbstracts(newActive, setProgress);
        for (let i = 0; i < updates.length; i += 20) {
          await Promise.all(
            updates
              .slice(i, i + 20)
              .map((u) =>
                supabase
                  .from("records")
                  .update({ abstract: u.abstract })
                  .eq("id", u.recordId)
              )
          );
        }
        absNote = ` Abstracts: filled ${updates.length} of ${missingAbs.length} missing automatically.`;
      } catch {
        absNote = "";
      }
      setProgress(null);
    }

    setFiBusy(false);
    setFileSeed(null);
    setFiRefs(null);
    setResult(
      `Imported ${imported + duplicates} record(s) from ${fiName} as ${fiDir} snowballing from "${seed.title.slice(0, 50)}": ${imported} new, ${duplicates} marked as duplicates. They join title/abstract screening as usual.${
        linksMissing
          ? " (Per seed provenance was not recorded: run supabase/migrations/0010_snowball_links.sql.)"
          : ""
      }${absNote}`
    );
    load();
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
    let linksMissing = false;
    const newActive: {
      id: string;
      title: string;
      abstract: string | null;
      doi: string | null;
      norm_doi: string | null;
      norm_title: string | null;
    }[] = [];
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
          // OpenAlex abstract fields sometimes hold junk (author lists,
          // reference sections); a blank beats importing that.
          abstract: plausibleAbstract(c.ref.abstract) ? c.ref.abstract : null,
          doi: c.ref.doi,
          url: c.ref.url,
          source_label: `Snowball ${dir}`,
          status: isDup ? "duplicate" : "active",
          norm_doi,
          norm_title,
        };
      });
      for (let i = 0; i < rows.length; i += 200) {
        const { data: inserted, error: insErr } = await supabase
          .from("records")
          .insert(rows.slice(i, i + 200))
          .select("id");
        if (insErr) {
          setError(insErr.message);
          setImporting(false);
          return;
        }
        (inserted ?? []).forEach((row, j) => {
          const src = rows[i + j];
          if (!src || src.status !== "active") return;
          newActive.push({
            id: row.id,
            title: src.title,
            abstract: src.abstract,
            doi: src.doi,
            norm_doi: src.norm_doi,
            norm_title: src.norm_title,
          });
        });
        // Per seed provenance: one link per (paper, seed, direction).
        const linkRows: {
          project_id: string;
          record_id: string;
          seed_record_id: string;
          direction: Direction;
        }[] = [];
        (inserted ?? []).forEach((row, j) => {
          const cand = group[i + j];
          if (!cand) return;
          const seen = new Set<string>();
          for (const s of cand.sources) {
            const k = `${s.seedId}:${s.dir}`;
            if (seen.has(k)) continue;
            seen.add(k);
            linkRows.push({
              project_id: projectId,
              record_id: row.id,
              seed_record_id: s.seedId,
              direction: s.dir,
            });
          }
        });
        if (linkRows.length > 0) {
          const { error: lkErr } = await supabase
            .from("snowball_links")
            .insert(linkRows);
          if (lkErr && lkErr.message.includes("does not exist")) {
            linksMissing = true;
          } else if (lkErr) {
            setError(lkErr.message);
          }
        }
      }
      await supabase
        .from("import_batches")
        .update({ record_count: rows.length })
        .eq("id", batch.id);
      // Candidates this round surfaced in this direction, before any
      // selection: the snowball analog of a database's raw hit count.
      // Best effort; fails harmlessly before migration 0011.
      const foundInDir = candidates.filter(
        (c) => !c.existing && c.sources[0].dir === dir
      ).length;
      await supabase
        .from("import_batches")
        .update({ raw_hit_count: foundInDir })
        .eq("id", batch.id);
    }
    // Fill missing abstracts for the fresh imports right away, so they
    // arrive in the screening queue readable.
    let absNote = "";
    const missingAbs = newActive.filter((r) => !plausibleAbstract(r.abstract));
    if (missingAbs.length > 0) {
      try {
        setProgress("Fetching missing abstracts for the imported records...");
        const { updates } = await findMissingAbstracts(newActive, setProgress);
        for (let i = 0; i < updates.length; i += 20) {
          await Promise.all(
            updates
              .slice(i, i + 20)
              .map((u) =>
                supabase
                  .from("records")
                  .update({ abstract: u.abstract })
                  .eq("id", u.recordId)
              )
          );
        }
        absNote = ` Abstracts: filled ${updates.length} of ${missingAbs.length} missing automatically; the rest can be pasted during screening.`;
      } catch {
        absNote =
          " Abstract lookup could not run; use Find missing abstracts on the Records page later.";
      }
      setProgress(null);
    }

    setImporting(false);
    setResult(
      `Imported ${imported + duplicates} snowball record(s): ${imported} new, ${duplicates} marked as duplicates. New records join title/abstract screening: distribute them from the project home, or they appear in the unassigned pool once your own assigned queue is done.${
        linksMissing
          ? " (Per seed provenance was not recorded: run supabase/migrations/0010_snowball_links.sql.)"
          : ""
      }${absNote}`
    );
    setCandidates(null);
    load();
  }

  const sortedCandidates = useMemo(() => {
    if (!candidates) return null;
    const copy = [...candidates];
    copy.sort((a, b) => {
      if (a.existing !== b.existing) return a.existing ? 1 : -1;
      if (candSort === "year") {
        return (b.ref.year ?? -1) - (a.ref.year ?? -1) || b.citedBy - a.citedBy;
      }
      return b.citedBy - a.citedBy;
    });
    return copy;
  }, [candidates, candSort]);

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
      <input
        type="file"
        accept=".ris,.txt,.bib,.bibtex,.csv,.tsv"
        ref={fiInputRef}
        className="hidden"
        onChange={onRefFilePicked}
      />
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
            No papers are included after full text screening yet. Webster and
            Watson snowball from the included set, so finish full text
            screening first; newly included papers then appear here as seeds.
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
                <button
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setFileSeed(s);
                    setFiDir("backward");
                    setFiRefs(null);
                    setFiName("");
                    setFiError(null);
                  }}
                  title="Import this paper's references or cited-by list from a Scopus / Web of Science file export"
                  className="shrink-0 rounded-full border border-zinc-300 px-2 py-0.5 text-xs text-zinc-600 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800"
                >
                  file import
                </button>
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
          {dirFwd && (
            <select
              value={fwdNewest ? "newest" : "cited"}
              onChange={(e) => setFwdNewest(e.target.value === "newest")}
              className="h-8 rounded-lg border border-zinc-300 bg-white px-2 text-xs text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300"
              title="Which citing papers to keep when a seed has more than 400"
            >
              <option value="newest">Forward: keep newest</option>
              <option value="cited">Forward: keep most cited</option>
            </select>
          )}
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
            <select
              value={candSort}
              onChange={(e) => setCandSort(e.target.value as "year" | "cited")}
              className="h-8 rounded-lg border border-zinc-300 bg-white px-2 text-xs text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300"
            >
              <option value="year">Sort: newest first</option>
              <option value="cited">Sort: most cited first</option>
            </select>
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
          <p className="mb-3 text-sm text-zinc-600 dark:text-zinc-300">
            All new candidates start selected. The clean method is to import
            everything and let title/abstract screening decide, so every
            exclusion is on record. Deselect only broken metadata or scope
            cuts you will report in your methods; whatever you deselect here
            never appears in your PRISMA numbers.
          </p>

          <div className="mb-3 flex max-h-[60vh] flex-col gap-1 overflow-y-auto">
            {(sortedCandidates ?? []).map((c) => (
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
                  {c.kind && (
                    <span
                      title="Probably not a peer reviewed journal or conference article (OpenAlex typing, advisory only)"
                      className="rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-800 dark:bg-amber-950 dark:text-amber-300"
                    >
                      {c.kind}
                    </span>
                  )}
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
            {importing ? (progress ?? "Importing...") : `Import ${selectedCount} selected`}
          </button>
        </section>
      )}

      {/* ------------- Per seed file import dialog ------------- */}
      {fileSeed && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6">
          <div className="w-full max-w-lg rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-700 dark:bg-zinc-900">
            <h3 className="mb-1 font-semibold text-zinc-900 dark:text-zinc-50">
              Import references or citations from a file
            </h3>
            <p className="mb-3 text-sm text-zinc-600 dark:text-zinc-400">
              For: <span className="font-medium">{fileSeed.title}</span>
            </p>
            <p className="mb-3 text-sm text-zinc-600 dark:text-zinc-300">
              In Scopus or Web of Science, open this paper, use its
              References list (backward) or Cited by list (forward), select
              all, and export as RIS including abstracts. Then choose that
              file here; the records enter the normal snowball pipeline
              with this paper recorded as their seed.
            </p>
            <div className="mb-3 flex flex-col gap-1 text-sm text-zinc-700 dark:text-zinc-300">
              <label className="flex cursor-pointer items-center gap-2">
                <input
                  type="radio"
                  checked={fiDir === "backward"}
                  onChange={() => setFiDir("backward")}
                />
                References of this paper (backward)
              </label>
              <label className="flex cursor-pointer items-center gap-2">
                <input
                  type="radio"
                  checked={fiDir === "forward"}
                  onChange={() => setFiDir("forward")}
                />
                Papers citing this paper (forward)
              </label>
            </div>
            <div className="mb-4 flex flex-wrap items-center gap-2">
              <button
                onClick={() => fiInputRef.current?.click()}
                className={ghostBtn}
              >
                Choose file (RIS, BibTeX, CSV)
              </button>
              {fiName && (
                <span className="text-sm text-zinc-600 dark:text-zinc-400">
                  {fiName}
                  {fiRefs ? ` · ${fiRefs.length} record(s) parsed` : ""}
                </span>
              )}
            </div>
            {fiError && (
              <p className="mb-3 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
                {fiError}
              </p>
            )}
            <div className="flex gap-2">
              <button
                onClick={importFileRefs}
                disabled={!fiRefs || fiRefs.length === 0 || fiBusy}
                className={primaryBtn}
              >
                {fiBusy
                  ? (progress ?? "Importing...")
                  : `Import ${fiRefs?.length ?? 0} as ${fiDir}`}
              </button>
              <button
                onClick={() => {
                  setFileSeed(null);
                  setFiRefs(null);
                }}
                disabled={fiBusy}
                className={ghostBtn}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
