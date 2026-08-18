"use client";

import { useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { uploadFulltext } from "@/lib/fulltext";
import { extractFirstPagesText, matchRecord } from "@/lib/pdfMatch";
import type { RecordRow } from "@/lib/types";

type RowStatus = "parsing" | "ready" | "uploading" | "uploaded" | "error";

type Row = {
  file: File;
  status: RowStatus;
  matchLabel: string;
  selectedId: string; // "" = unassigned
  note: string;
};

export default function BulkPdfUpload({
  projectId,
  onDone,
}: {
  projectId: string;
  onDone: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<Row[]>([]);
  const [candidates, setCandidates] = useState<RecordRow[]>([]);
  const [processing, setProcessing] = useState(false);
  const [uploadingAll, setUploadingAll] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  async function loadCandidates(): Promise<RecordRow[]> {
    const supabase = createClient();
    const out: RecordRow[] = [];
    for (let from = 0; ; from += 1000) {
      const { data, error: qErr } = await supabase
        .from("records")
        .select("*")
        .eq("project_id", projectId)
        .eq("status", "active")
        .range(from, from + 999);
      if (qErr) {
        setError(qErr.message);
        break;
      }
      out.push(...((data ?? []) as RecordRow[]));
      if (!data || data.length < 1000) break;
    }
    // Records still lacking a PDF first, then by title.
    out.sort((a, b) => {
      const ap = a.fulltext_path ? 1 : 0;
      const bp = b.fulltext_path ? 1 : 0;
      if (ap !== bp) return ap - bp;
      return a.title.localeCompare(b.title);
    });
    setCandidates(out);
    return out;
  }

  async function handleFiles(list: FileList | File[]) {
    const files = [...list].filter((f) =>
      f.name.toLowerCase().endsWith(".pdf")
    );
    if (files.length === 0) return;
    setProcessing(true);
    setError(null);
    const cands = candidates.length > 0 ? candidates : await loadCandidates();

    const newRows: Row[] = files.map((file) => ({
      file,
      status: "parsing",
      matchLabel: "...",
      selectedId: "",
      note: "",
    }));
    setRows((r) => [...r, ...newRows]);

    // Track records already claimed in this session so two files do not
    // silently target the same record.
    const claimed = new Set(
      rows.filter((r) => r.selectedId).map((r) => r.selectedId)
    );

    for (const row of newRows) {
      let matchLabel = "no match";
      let selectedId = "";
      let note = "";
      let status: RowStatus = "ready";
      try {
        const text = await extractFirstPagesText(row.file);
        if (text.trim().length < 40) {
          note = "No text layer (scanned PDF?); assign manually.";
        } else {
          const m = matchRecord(text, cands);
          if (m) {
            if (claimed.has(m.record.id)) {
              note = "Another file already matched this record; assign manually.";
            } else {
              selectedId = m.record.id;
              claimed.add(m.record.id);
              matchLabel =
                m.kind === "doi"
                  ? "DOI exact"
                  : `title ${(m.score * 100).toFixed(0)}%`;
              if (m.record.fulltext_path) {
                note = "Record already has a PDF; uploading replaces it.";
              }
            }
          }
        }
      } catch (e) {
        status = "error";
        note = e instanceof Error ? e.message : String(e);
      }
      setRows((rs) =>
        rs.map((r) =>
          r.file === row.file
            ? { ...r, status, matchLabel, selectedId, note }
            : r
        )
      );
    }
    setProcessing(false);
  }

  async function uploadAll() {
    setUploadingAll(true);
    for (const row of rows) {
      if (row.status !== "ready" || !row.selectedId) continue;
      setRows((rs) =>
        rs.map((r) => (r.file === row.file ? { ...r, status: "uploading" } : r))
      );
      const err = await uploadFulltext(projectId, row.selectedId, row.file);
      setRows((rs) =>
        rs.map((r) =>
          r.file === row.file
            ? {
                ...r,
                status: err ? "error" : "uploaded",
                note: err ?? r.note,
              }
            : r
        )
      );
    }
    setUploadingAll(false);
    onDone();
  }

  const readyCount = rows.filter(
    (r) => r.status === "ready" && r.selectedId
  ).length;
  const unassigned = rows.filter(
    (r) => r.status === "ready" && !r.selectedId
  ).length;

  const card =
    "rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900";

  if (!open) {
    return (
      <div className="mb-4">
        <button
          onClick={() => {
            setOpen(true);
            loadCandidates();
          }}
          className="rounded-full border border-zinc-300 px-4 py-2 text-sm text-zinc-700 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
        >
          Bulk PDF upload
        </button>
      </div>
    );
  }

  return (
    <div className={`${card} mb-4`}>
      <input
        type="file"
        accept="application/pdf,.pdf"
        multiple
        ref={fileRef}
        className="hidden"
        onChange={(e) => {
          if (e.target.files) handleFiles(e.target.files);
          e.target.value = "";
        }}
      />
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">
          Bulk PDF upload
        </h2>
        <button
          onClick={() => {
            setOpen(false);
            setRows([]);
          }}
          className="text-xs text-zinc-400 underline underline-offset-2"
        >
          close
        </button>
      </div>

      <div
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          handleFiles(e.dataTransfer.files);
        }}
        onClick={() => fileRef.current?.click()}
        className="mb-3 cursor-pointer rounded-lg border-2 border-dashed border-zinc-300 p-6 text-center text-sm text-zinc-500 transition-colors hover:border-zinc-400 dark:border-zinc-700 dark:text-zinc-400 dark:hover:border-zinc-500"
      >
        Drop PDFs here (or click to pick). Each file is read in your browser
        and matched to a record by the DOI printed in it, or by its title.
      </div>

      {error && (
        <p className="mb-2 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
          {error}
        </p>
      )}

      {rows.length > 0 && (
        <>
          <div className="mb-3 flex flex-col gap-1">
            {rows.map((row, i) => (
              <div
                key={i}
                className="flex flex-wrap items-center gap-2 rounded-lg bg-zinc-50 px-3 py-2 text-xs dark:bg-zinc-950"
              >
                <span className="max-w-48 truncate font-medium text-zinc-700 dark:text-zinc-300">
                  {row.file.name}
                </span>
                <span
                  className={
                    row.status === "uploaded"
                      ? "text-emerald-600"
                      : row.status === "error"
                        ? "text-red-600"
                        : row.matchLabel === "no match"
                          ? "text-amber-600"
                          : "text-zinc-400"
                  }
                >
                  {row.status === "parsing"
                    ? "reading..."
                    : row.status === "uploading"
                      ? "uploading..."
                      : row.status === "uploaded"
                        ? "uploaded"
                        : row.status === "error"
                          ? "failed"
                          : row.matchLabel}
                </span>
                {(row.status === "ready" || row.status === "error") && (
                  <select
                    value={row.selectedId}
                    onChange={(e) =>
                      setRows((rs) =>
                        rs.map((r) =>
                          r.file === row.file
                            ? { ...r, selectedId: e.target.value, status: "ready" }
                            : r
                        )
                      )
                    }
                    className="min-w-0 flex-1 rounded border border-zinc-300 bg-white px-1 py-0.5 text-xs dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300"
                  >
                    <option value="">Assign to record...</option>
                    {candidates.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.fulltext_path ? "[has PDF] " : ""}
                        {c.title.slice(0, 80)}
                      </option>
                    ))}
                  </select>
                )}
                {row.note && (
                  <span className="w-full text-zinc-400">{row.note}</span>
                )}
              </div>
            ))}
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={uploadAll}
              disabled={uploadingAll || processing || readyCount === 0}
              className="rounded-full bg-zinc-900 px-4 py-2 text-sm font-medium text-zinc-50 transition-colors hover:bg-zinc-700 disabled:opacity-40 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-300"
            >
              {uploadingAll
                ? "Uploading..."
                : `Upload ${readyCount} matched PDF(s)`}
            </button>
            {unassigned > 0 && (
              <span className="text-xs text-amber-600">
                {unassigned} file(s) still unassigned
              </span>
            )}
          </div>
        </>
      )}
    </div>
  );
}
