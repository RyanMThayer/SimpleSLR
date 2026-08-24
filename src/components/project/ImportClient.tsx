"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { parseRis } from "@/lib/ris";
import { parseBibtex } from "@/lib/bibtex";
import { parseCsv, guessMapping, rowsToRefs, type ColumnMapping } from "@/lib/csv";
import {
  normalizeTitle,
  normalizeDoi,
  authorTokens,
  sharesAuthor,
} from "@/lib/normalize";
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

/**
 * Reusable import panel. When databaseId is set, the created batch and
 * its records are linked to that database for provenance.
 */
export default function ImportClient({
  projectId,
  userId,
  databaseId = null,
  sourceLabelDefault = "",
  onDone,
}: {
  projectId: string;
  userId: string;
  databaseId?: string | null;
  sourceLabelDefault?: string;
  onDone?: () => void;
}) {
  const [fileName, setFileName] = useState<string | null>(null);
  const [sourceLabel, setSourceLabel] = useState(sourceLabelDefault);
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
      setSourceLabel(sourceLabelDefault || file.name.replace(/\.[^.]+$/, ""));
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
    } else if (lower.endsWith(".bib") || lower.endsWith(".bibtex")) {
      const parsed = parseBibtex(text);
      if (parsed.length === 0) {
        setError("No records found in this BibTeX file.");
        return;
      }
      setRefs(parsed);
    } else {
      // Treat everything else (.ris, .txt) as RIS.
      const parsed = parseRis(text);
      if (parsed.length === 0) {
        setError(
          "No records found. Expected a RIS, BibTeX, or CSV export from the database."
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

    // The same file imported twice for the same database is almost
    // always an accident; it would only create duplicate records.
    if (fileName) {
      let priorQuery = supabase
        .from("import_batches")
        .select("record_count, created_at")
        .eq("project_id", projectId)
        .eq("filename", fileName)
        .order("created_at")
        .limit(1);
      priorQuery = databaseId
        ? priorQuery.eq("database_id", databaseId)
        : priorQuery.is("database_id", null);
      const { data: prior } = await priorQuery;
      if (prior && prior.length > 0) {
        const ok = window.confirm(
          `"${fileName}" was already imported here on ${new Date(prior[0].created_at).toLocaleDateString()} (${prior[0].record_count} records). Importing it again only creates duplicates. Import anyway?`
        );
        if (!ok) {
          setImporting(false);
          return;
        }
      }
    }

    setProgress("Checking for duplicates...");
    const existingDois = new Set<string>();
    // Title matches need corroboration (shared author, or matching year
    // when authors are missing), so keep authors and year per title.
    type TitleInfo = { tokens: Set<string>; year: number | null };
    const existingTitles = new Map<string, TitleInfo[]>();
    const addTitle = (title: string, info: TitleInfo) => {
      const list = existingTitles.get(title);
      if (list) list.push(info);
      else existingTitles.set(title, [info]);
    };
    const corroborated = (title: string, info: TitleInfo): boolean => {
      const candidates = existingTitles.get(title);
      if (!candidates) return false;
      return candidates.some((c) =>
        c.tokens.size > 0 && info.tokens.size > 0
          ? sharesAuthor(c.tokens, info.tokens)
          : c.year !== null && info.year !== null && c.year === info.year
      );
    };
    const pageSize = 1000;
    for (let from = 0; ; from += pageSize) {
      const { data, error: exErr } = await supabase
        .from("records")
        .select("norm_doi, norm_title, authors, year")
        .eq("project_id", projectId)
        .range(from, from + pageSize - 1);
      if (exErr) {
        setError(exErr.message);
        setImporting(false);
        return;
      }
      (data ?? []).forEach((r) => {
        if (r.norm_doi) existingDois.add(r.norm_doi);
        if (r.norm_title) {
          addTitle(r.norm_title, {
            tokens: authorTokens(r.authors),
            year: r.year,
          });
        }
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
        database_id: databaseId,
      })
      .select("id")
      .single();
    if (batchErr || !batch) {
      setError(batchErr?.message ?? "Could not create the import batch.");
      setImporting(false);
      return;
    }

    let duplicates = 0;
    let uncorroborated = 0;
    const rows = refs.map((r) => {
      const norm_doi = normalizeDoi(r.doi);
      const norm_title = normalizeTitle(r.title);
      const info = { tokens: authorTokens(r.authors), year: r.year };
      const doiDup = norm_doi !== null && existingDois.has(norm_doi);
      const titleMatched =
        norm_title !== "" && existingTitles.has(norm_title);
      const titleDup = titleMatched && corroborated(norm_title, info);
      const isDup = doiDup || titleDup;
      if (!isDup && titleMatched) uncorroborated++;
      if (norm_doi) existingDois.add(norm_doi);
      if (norm_title) addTitle(norm_title, info);
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
      `Imported ${rows.length} records: ${rows.length - duplicates} new, ${duplicates} marked as duplicates (matching DOI, or matching title confirmed by a shared author or year).` +
        (uncorroborated > 0
          ? ` ${uncorroborated} title match(es) had no author or year confirmation and were kept as unique; check them in the records table if that seems off.`
          : "")
    );
    setRefs(null);
    setCsvRows(null);
    setCsvHeader(null);
    setFileName(null);
    onDone?.();
  }

  const withAbstract = refs?.filter((r) => r.abstract).length ?? 0;
  const withDoi = refs?.filter((r) => r.doi).length ?? 0;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <label className="flex flex-1 flex-col gap-1 text-sm font-medium text-zinc-700 dark:text-zinc-300">
          Source label (used in PRISMA counts)
          <input
            className="h-10 rounded-lg border border-zinc-300 bg-white px-3 text-sm text-zinc-900 outline-none focus:border-teal-600 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50"
            placeholder="e.g. Scopus 2026-08-18"
            value={sourceLabel}
            onChange={(e) => setSourceLabel(e.target.value)}
          />
        </label>
        <label className="flex flex-1 flex-col gap-1 text-sm font-medium text-zinc-700 dark:text-zinc-300">
          File (.ris, .bib, .csv, .txt)
          <input
            type="file"
            accept=".ris,.txt,.csv,.tsv,.bib,.bibtex"
            onChange={onFile}
            className="text-sm text-zinc-600 file:mr-3 file:rounded-full file:border-0 file:bg-zinc-900 file:px-4 file:py-2 file:text-sm file:font-medium file:text-zinc-50 dark:text-zinc-400 dark:file:bg-zinc-50 dark:file:text-zinc-900"
          />
        </label>
      </div>

      {csvHeader && mapping && (
        <div className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
          <h3 className="mb-2 text-sm font-semibold text-zinc-900 dark:text-zinc-50">
            Column mapping
          </h3>
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
        <p className="rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
          {error}
        </p>
      )}

      {refs && refs.length > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-zinc-200 px-4 py-3 dark:border-zinc-800">
          <span className="text-sm text-zinc-700 dark:text-zinc-300">
            <strong>{refs.length}</strong> records parsed · {withAbstract} with
            abstract · {withDoi} with DOI
          </span>
          <button
            onClick={runImport}
            disabled={importing}
            className="rounded-full bg-teal-700 px-5 py-2 text-sm font-medium text-zinc-50 transition-colors hover:bg-teal-800 disabled:opacity-50 dark:bg-teal-400 dark:text-teal-950 dark:hover:bg-teal-300"
          >
            {importing ? (progress ?? "Importing...") : "Import"}
          </button>
        </div>
      )}

      {result && (
        <p className="rounded-lg border border-teal-300 bg-teal-50 px-4 py-3 text-sm text-teal-800 dark:border-teal-800 dark:bg-teal-950 dark:text-teal-200">
          {result}
        </p>
      )}
    </div>
  );
}
