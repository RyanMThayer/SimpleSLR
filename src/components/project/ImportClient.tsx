"use client";

import { useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { parseRis } from "@/lib/ris";
import { parseCsv, guessMapping, rowsToRefs, type ColumnMapping } from "@/lib/csv";
import { normalizeTitle, normalizeDoi } from "@/lib/normalize";
import type { ParsedRef } from "@/lib/types";

const FIELD_LABELS: { key: keyof ColumnMapping; label: string }[] = [
  { key: "title", label: "Title (required)" },
  { key: "authors", label: "Authors" },
  { key: "year", label: "Year" },
  { key: "venue", label: "Venue / source" },
  { key: "abstract", label: "Abstract" },
  { key: "doi", label: "DOI" },
  { key: "url", label: "URL" },
];

export default function ImportClient({
  projectId,
  userId,
}: {
  projectId: string;
  userId: string;
}) {
  const [fileName, setFileName] = useState<string | null>(null);
  const [sourceLabel, setSourceLabel] = useState("");
  const [refs, setRefs] = useState<ParsedRef[] | null>(null);
  const [csvRows, setCsvRows] = useState<string[][] | null>(null);
  const [csvHeader, setCsvHeader] = useState<string[] | null>(null);
  const [mapping, setMapping] = useState<ColumnMapping | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  function reset() {
    setRefs(null);
    setCsvRows(null);
    setCsvHeader(null);
    setMapping(null);
    setError(null);
    setResult(null);
    setProgress(null);
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    reset();
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    if (!sourceLabel) {
      const base = file.name.replace(/\.[^.]+$/, "");
      setSourceLabel(base);
    }
    const text = await file.text();
    const lower = file.name.toLowerCase();
    if (lower.endsWith(".csv") || lower.endsWith(".tsv")) {
      const rows = parseCsv(
        lower.endsWith(".tsv") ? text.replace(/\t/g, ",") : text
      );
      if (rows.length < 2) {
        setError("The CSV appears to be empty or has no data rows.");
        return;
      }
      const header = rows[0];
      const dataRows = rows.slice(1);
      const guessed = guessMapping(header);
      setCsvHeader(header);
      setCsvRows(dataRows);
      setMapping(guessed);
      if (guessed.title === null) {
        setError(
          "Could not find a title column automatically. Pick it below before importing."
        );
      } else {
        setRefs(rowsToRefs(dataRows, guessed));
      }
    } else {
      // Treat everything else (.ris, .txt) as RIS.
      const parsed = parseRis(text);
      if (parsed.length === 0) {
        setError(
          "No records found. Expected a RIS file (from Scopus, Web of Science, or IEEE Xplore) or a CSV export."
        );
        return;
      }
      setRefs(parsed);
    }
  }

  function updateMapping(key: keyof ColumnMapping, value: string) {
    if (!mapping || !csvRows) return;
    const next = { ...mapping, [key]: value === "" ? null : parseInt(value, 10) };
    setMapping(next);
    setError(null);
    if (next.title !== null) {
      setRefs(rowsToRefs(csvRows, next));
    } else {
      setRefs(null);
    }
  }

  async function runImport() {
    if (!refs || refs.length === 0) return;
    setImporting(true);
    setError(null);
    setResult(null);
    const supabase = createClient();

    // Existing dedup keys in this project.
    setProgress("Checking for duplicates...");
    const existingDois = new Set<string>();
    const existingTitles = new Set<string>();
    const pageSize = 1000;
    for (let from = 0; ; from += pageSize) {
      const { data, error: exErr } = await supabase
        .from("records")
        .select("norm_doi, norm_title")
        .eq("project_id", projectId)
        .range(from, from + pageSize - 1);
      if (exErr) {
        setError(exErr.message);
        setImporting(false);
        return;
      }
      (data ?? []).forEach((r) => {
        if (r.norm_doi) existingDois.add(r.norm_doi);
        if (r.norm_title) existingTitles.add(r.norm_title);
      });
      if (!data || data.length < pageSize) break;
    }

    const { data: batch, error: batchErr } = await supabase
      .from("import_batches")
      .insert({
        project_id: projectId,
        filename: fileName,
        source_label: sourceLabel || null,
        imported_by: userId,
      })
      .select("id")
      .single();
    if (batchErr || !batch) {
      setError(batchErr?.message ?? "Could not create the import batch.");
      setImporting(false);
      return;
    }

    let duplicates = 0;
    const rows = refs.map((r) => {
      const norm_doi = normalizeDoi(r.doi);
      const norm_title = normalizeTitle(r.title);
      const isDup =
        (norm_doi !== null && existingDois.has(norm_doi)) ||
        (norm_title !== "" && existingTitles.has(norm_title));
      if (norm_doi) existingDois.add(norm_doi);
      if (norm_title) existingTitles.add(norm_title);
      if (isDup) duplicates++;
      return {
        project_id: projectId,
        batch_id: batch.id,
        title: r.title,
        authors: r.authors,
        year: r.year,
        venue: r.venue,
        abstract: r.abstract,
        doi: r.doi,
        url: r.url,
        source_label: sourceLabel || null,
        status: isDup ? "duplicate" : "active",
        norm_doi,
        norm_title,
      };
    });

    for (let i = 0; i < rows.length; i += 200) {
      setProgress(`Importing ${Math.min(i + 200, rows.length)} / ${rows.length}...`);
      const { error: insErr } = await supabase
        .from("records")
        .insert(rows.slice(i, i + 200));
      if (insErr) {
        setError(`Import stopped at row ${i}: ${insErr.message}`);
        setImporting(false);
        return;
      }
    }

    await supabase
      .from("import_batches")
      .update({ record_count: rows.length })
      .eq("id", batch.id);

    setProgress(null);
    setImporting(false);
    setResult(
      `Imported ${rows.length} records: ${rows.length - duplicates} new, ${duplicates} automatically marked as duplicates (matching DOI or title).`
    );
    setRefs(null);
    setCsvRows(null);
    setCsvHeader(null);
    setFileName(null);
  }

  const withAbstract = refs?.filter((r) => r.abstract).length ?? 0;
  const withDoi = refs?.filter((r) => r.doi).length ?? 0;

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-8">
      <h1 className="mb-2 text-2xl font-semibold text-zinc-900 dark:text-zinc-50">
        Import records
      </h1>
      <p className="mb-6 text-sm text-zinc-500 dark:text-zinc-400">
        Upload a RIS or CSV export from Scopus, Web of Science, or IEEE Xplore.
        Records matching an existing DOI or title are marked as duplicates
        automatically.
      </p>

      <div className="mb-4 flex flex-col gap-3 rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
        <label className="flex flex-col gap-1 text-sm font-medium text-zinc-700 dark:text-zinc-300">
          Source label (shows up in PRISMA counts later)
          <input
            className="h-10 rounded-lg border border-zinc-300 bg-white px-3 text-sm text-zinc-900 outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50"
            placeholder="e.g. Scopus search 2026-08-17"
            value={sourceLabel}
            onChange={(e) => setSourceLabel(e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium text-zinc-700 dark:text-zinc-300">
          File (.ris, .txt, .csv)
          <input
            type="file"
            accept=".ris,.txt,.csv,.tsv"
            onChange={onFile}
            className="text-sm text-zinc-600 file:mr-3 file:rounded-full file:border-0 file:bg-zinc-900 file:px-4 file:py-2 file:text-sm file:font-medium file:text-zinc-50 dark:text-zinc-400 dark:file:bg-zinc-50 dark:file:text-zinc-900"
          />
        </label>
      </div>

      {csvHeader && mapping && (
        <div className="mb-4 rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
          <h2 className="mb-3 font-semibold text-zinc-900 dark:text-zinc-50">
            Column mapping
          </h2>
          <div className="grid gap-3 sm:grid-cols-2">
            {FIELD_LABELS.map(({ key, label }) => (
              <label
                key={key}
                className="flex flex-col gap-1 text-sm font-medium text-zinc-700 dark:text-zinc-300"
              >
                {label}
                <select
                  className="h-10 rounded-lg border border-zinc-300 bg-white px-2 text-sm text-zinc-900 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50"
                  value={mapping[key] ?? ""}
                  onChange={(e) => updateMapping(key, e.target.value)}
                >
                  <option value="">(none)</option>
                  {csvHeader.map((h, i) => (
                    <option key={i} value={i}>
                      {h || `column ${i + 1}`}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>
        </div>
      )}

      {error && (
        <p className="mb-4 rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
          {error}
        </p>
      )}

      {refs && refs.length > 0 && (
        <div className="mb-4 rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
          <h2 className="mb-1 font-semibold text-zinc-900 dark:text-zinc-50">
            Ready to import: {refs.length} records
          </h2>
          <p className="mb-3 text-sm text-zinc-500 dark:text-zinc-400">
            {withAbstract} with abstract · {withDoi} with DOI · first title:{" "}
            {refs[0].title.slice(0, 80)}
            {refs[0].title.length > 80 ? "..." : ""}
          </p>
          <button
            onClick={runImport}
            disabled={importing}
            className="rounded-full bg-zinc-900 px-5 py-2 text-sm font-medium text-zinc-50 transition-colors hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-300"
          >
            {importing ? (progress ?? "Importing...") : "Import"}
          </button>
        </div>
      )}

      {result && (
        <div className="mb-4 rounded-lg border border-emerald-300 bg-emerald-50 px-4 py-3 text-sm text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-200">
          {result}{" "}
          <Link href={`/projects/${projectId}`} className="underline underline-offset-2">
            Back to the project
          </Link>
        </div>
      )}
    </main>
  );
}
