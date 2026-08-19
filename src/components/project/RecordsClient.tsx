"use client";

import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { normalizeTitle, normalizeDoi } from "@/lib/normalize";
import { outcomeOf } from "@/lib/outcomes";
import {
  abstractFromPdfText,
  findMissingAbstracts,
  plausibleAbstract,
} from "@/lib/abstracts";
import { fetchOaPdfUrls } from "@/lib/openalex";
import {
  removeFulltext,
  removeFulltextPaths,
  signedFulltextUrl,
  uploadFulltext,
} from "@/lib/fulltext";
import BulkPdfUpload from "@/components/project/BulkPdfUpload";
import { useRef } from "react";
import {
  collectDependents,
  repairDependents,
  repairSummary,
} from "@/lib/rededupe";
import type { Decision, Stage } from "@/lib/types";
import type {
  ExclusionReason,
  ImportBatch,
  RecordRow,
  ScreeningDecision,
} from "@/lib/types";

const PAGE_SIZE = 50;

type StatusFilter = "all" | "active" | "duplicate";
type DecisionFilter = "all" | "include" | "exclude" | "undecided";

type SourceSummary = {
  key: string; // database id, or "unlinked"
  name: string;
  batchIds: string[];
  imported: number;
  duplicates: number;
};

type EditForm = {
  title: string;
  authors: string;
  year: string;
  venue: string;
  abstract: string;
  doi: string;
  url: string;
};

export default function RecordsClient({
  projectId,
  userId,
}: {
  projectId: string;
  userId: string;
}) {
  const [rows, setRows] = useState<RecordRow[] | null>(null);
  const [taDecs, setTaDecs] = useState<Map<string, ScreeningDecision[]>>(
    new Map()
  );
  const [ftDecs, setFtDecs] = useState<Map<string, ScreeningDecision[]>>(
    new Map()
  );
  const [sources, setSources] = useState<SourceSummary[] | null>(null);
  const [reasons, setReasons] = useState<ExclusionReason[]>([]);
  const [sourceFilter, setSourceFilter] = useState<string>("all");
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<StatusFilter>("active");
  const [decisionFilter, setDecisionFilter] = useState<DecisionFilter>("all");
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [snowLinks, setSnowLinks] = useState<
    Map<string, { seedId: string; direction: string }[]>
  >(new Map());
  const [seedTitles, setSeedTitles] = useState<Map<string, string>>(new Map());
  const [absBusy, setAbsBusy] = useState(false);
  const [absMsg, setAbsMsg] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<EditForm | null>(null);
  const [saving, setSaving] = useState(false);
  const [uploadBusy, setUploadBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const uploadTarget = useRef<RecordRow | null>(null);

  const loadSources = useCallback(async () => {
    const supabase = createClient();
    const [dbRes, batchRes, reasonRes] = await Promise.all([
      supabase
        .from("project_databases")
        .select("id, name")
        .eq("project_id", projectId),
      supabase
        .from("import_batches")
        .select("*")
        .eq("project_id", projectId),
      supabase
        .from("exclusion_reasons")
        .select("*")
        .eq("project_id", projectId)
        .order("position"),
    ]);
    const dbs = (dbRes.data ?? []) as { id: string; name: string }[];
    const allBatches = (batchRes.data ?? []) as ImportBatch[];
    setReasons((reasonRes.data ?? []) as ExclusionReason[]);

    const raw: SourceSummary[] = [];
    for (const db of dbs) {
      const ids = allBatches
        .filter((b) => b.database_id === db.id)
        .map((b) => b.id);
      if (ids.length === 0) continue;
      raw.push({
        key: db.id,
        name: db.name,
        batchIds: ids,
        imported: allBatches
          .filter((b) => b.database_id === db.id)
          .reduce((s, b) => s + b.record_count, 0),
        duplicates: 0,
      });
    }
    const unlinkedIds = allBatches
      .filter((b) => b.database_id === null)
      .map((b) => b.id);
    if (unlinkedIds.length > 0) {
      raw.push({
        key: "unlinked",
        name: "Unlinked imports",
        batchIds: unlinkedIds,
        imported: allBatches
          .filter((b) => b.database_id === null)
          .reduce((s, b) => s + b.record_count, 0),
        duplicates: 0,
      });
    }

    const withDups = await Promise.all(
      raw.map(async (s) => {
        const { count } = await supabase
          .from("records")
          .select("id", { count: "exact", head: true })
          .eq("project_id", projectId)
          .eq("status", "duplicate")
          .in("batch_id", s.batchIds);
        return { ...s, duplicates: count ?? 0 };
      })
    );
    setSources(withDups);
  }, [projectId]);

  const load = useCallback(async () => {
    const supabase = createClient();
    let batchIds: string[] | null = null;
    if (sourceFilter !== "all") {
      const src = sources?.find((s) => s.key === sourceFilter);
      batchIds = src?.batchIds ?? [];
      if (batchIds.length === 0) {
        setRows([]);
        setTotal(0);
        return;
      }
    }

    let query = supabase
      .from("records")
      .select("*", { count: "exact" })
      .eq("project_id", projectId)
      .order("created_at")
      .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);
    if (status !== "all") query = query.eq("status", status);
    if (search.trim()) query = query.ilike("title", `%${search.trim()}%`);
    if (batchIds) query = query.in("batch_id", batchIds);

    const { data, count, error: qErr } = await query;
    if (qErr) {
      setError(qErr.message);
      setRows([]);
      return;
    }
    const records = (data ?? []) as RecordRow[];
    setError(null);
    setTotal(count ?? 0);

    const ids = records.map((r) => r.id);
    const ta = new Map<string, ScreeningDecision[]>();
    const ft = new Map<string, ScreeningDecision[]>();
    if (ids.length > 0) {
      const { data: dec } = await supabase
        .from("screening_decisions")
        .select("*")
        .in("record_id", ids);
      ((dec ?? []) as ScreeningDecision[]).forEach((d) => {
        const map = d.stage === "full_text" ? ft : ta;
        const list = map.get(d.record_id) ?? [];
        list.push(d);
        map.set(d.record_id, list);
      });
    }
    setTaDecs(ta);
    setFtDecs(ft);

    // Snowball provenance for the visible page. The query errors before
    // migration 0010; the panel then simply shows nothing.
    const linkMap = new Map<string, { seedId: string; direction: string }[]>();
    const titleMap = new Map<string, string>();
    if (ids.length > 0) {
      const { data: lk } = await supabase
        .from("snowball_links")
        .select("record_id, seed_record_id, direction")
        .in("record_id", ids);
      const links = (lk ?? []) as {
        record_id: string;
        seed_record_id: string;
        direction: string;
      }[];
      links.forEach((l) => {
        const list = linkMap.get(l.record_id) ?? [];
        list.push({ seedId: l.seed_record_id, direction: l.direction });
        linkMap.set(l.record_id, list);
      });
      const seedIds = [...new Set(links.map((l) => l.seed_record_id))];
      for (let i = 0; i < seedIds.length; i += 100) {
        const { data: seeds } = await supabase
          .from("records")
          .select("id, title")
          .in("id", seedIds.slice(i, i + 100));
        ((seeds ?? []) as { id: string; title: string }[]).forEach((s) =>
          titleMap.set(s.id, s.title)
        );
      }
    }
    setSnowLinks(linkMap);
    setSeedTitles(titleMap);

    if (decisionFilter === "all") {
      setRows(records);
    } else if (decisionFilter === "undecided") {
      setRows(records.filter((r) => !(ta.get(r.id)?.length ?? 0)));
    } else {
      setRows(
        records.filter((r) =>
          (ta.get(r.id) ?? []).some((d) => d.decision === decisionFilter)
        )
      );
    }
  }, [projectId, page, search, status, decisionFilter, sourceFilter, sources]);

  useEffect(() => {
    // Fetch-on-mount: state updates happen after awaits inside loadSources().
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadSources();
  }, [loadSources]);

  useEffect(() => {
    // Fetch-on-mount: state updates happen after awaits inside load().
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  async function deleteSource(src: SourceSummary) {
    const ok = window.confirm(
      `Delete all ${src.imported} records imported from ${src.name}, including any screening decisions on them? Records from other sources that were deduplicated against these will be re-checked and restored where appropriate. The database itself stays available for a fresh import. This cannot be undone.`
    );
    if (!ok) return;
    const supabase = createClient();
    const deletedIds: string[] = [];
    const pdfPaths: string[] = [];
    for (let i = 0; i < src.batchIds.length; i += 100) {
      const { data: idRows } = await supabase
        .from("records")
        .select("id, fulltext_path")
        .in("batch_id", src.batchIds.slice(i, i + 100));
      (idRows ?? []).forEach((r) => {
        deletedIds.push(r.id);
        if (r.fulltext_path) pdfPaths.push(r.fulltext_path);
      });
    }
    const dependents = await collectDependents(projectId, deletedIds);
    const { error: recErr } = await supabase
      .from("records")
      .delete()
      .in("batch_id", src.batchIds);
    if (recErr) {
      setError(recErr.message);
      return;
    }
    const { error: batchErr } = await supabase
      .from("import_batches")
      .delete()
      .in("id", src.batchIds);
    if (batchErr) {
      setError(batchErr.message);
      return;
    }
    await removeFulltextPaths(pdfPaths);
    try {
      await repairDependents(projectId, dependents, new Set(deletedIds));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    if (sourceFilter === src.key) setSourceFilter("all");
    setPage(0);
    loadSources();
    load();
  }

  function startEdit(r: RecordRow) {
    setEditingId(r.id);
    setForm({
      title: r.title,
      authors: r.authors ?? "",
      year: r.year?.toString() ?? "",
      venue: r.venue ?? "",
      abstract: r.abstract ?? "",
      doi: r.doi ?? "",
      url: r.url ?? "",
    });
  }

  async function saveEdit(recordId: string) {
    if (!form || !form.title.trim()) return;
    setSaving(true);
    const supabase = createClient();
    const yearMatch = form.year.match(/\d{4}/);
    const { error: upErr } = await supabase
      .from("records")
      .update({
        title: form.title.trim(),
        authors: form.authors.trim() || null,
        year: yearMatch ? parseInt(yearMatch[0], 10) : null,
        venue: form.venue.trim() || null,
        abstract: form.abstract.trim() || null,
        doi: form.doi.trim() || null,
        url: form.url.trim() || null,
        norm_title: normalizeTitle(form.title),
        norm_doi: normalizeDoi(form.doi.trim() || null),
      })
      .eq("id", recordId);
    setSaving(false);
    if (upErr) {
      setError(upErr.message);
      return;
    }
    setEditingId(null);
    setForm(null);
    load();
  }

  async function fetchMissingAbstracts() {
    if (absBusy) return;
    setAbsBusy(true);
    setAbsMsg("Collecting records without abstracts...");
    const supabase = createClient();
    try {
      const all: RecordRow[] = [];
      for (let from = 0; ; from += 1000) {
        const { data, error: qErr } = await supabase
          .from("records")
          .select("*")
          .eq("project_id", projectId)
          .eq("status", "active")
          .range(from, from + 999);
        if (qErr) throw new Error(qErr.message);
        all.push(...((data ?? []) as RecordRow[]));
        if (!data || data.length < 1000) break;
      }
      const missingBefore = all.filter(
        (r) => !plausibleAbstract(r.abstract)
      ).length;
      if (missingBefore === 0) {
        setAbsMsg("Every active record already has a plausible abstract.");
        setAbsBusy(false);
        return;
      }
      const { updates, notes } = await findMissingAbstracts(all, setAbsMsg);
      setAbsMsg(`Saving ${updates.length} abstracts...`);
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
      const bySource = new Map<string, number>();
      updates.forEach((u) =>
        bySource.set(u.source, (bySource.get(u.source) ?? 0) + 1)
      );
      const parts = [...bySource.entries()]
        .map(([s, n]) => `${s} ${n}`)
        .join(", ");
      const still = missingBefore - updates.length;
      setAbsMsg(
        `Found ${updates.length} of ${missingBefore} missing abstracts${
          parts ? ` (${parts})` : ""
        }.${
          still > 0
            ? ` ${still} still missing; paste those in from the screening room or via Edit here.`
            : ""
        }${notes.length ? ` ${notes.join(" ")}` : ""}`
      );
      load();
    } catch (e) {
      setAbsMsg(null);
      setError(e instanceof Error ? e.message : String(e));
    }
    setAbsBusy(false);
  }

  async function fetchOaEnrichment() {
    if (absBusy) return;
    setAbsBusy(true);
    setAbsMsg("Collecting records for the open access sweep...");
    const supabase = createClient();
    try {
      const all: RecordRow[] = [];
      for (let from = 0; ; from += 1000) {
        const { data, error: qErr } = await supabase
          .from("records")
          .select("*")
          .eq("project_id", projectId)
          .eq("status", "active")
          .range(from, from + 999);
        if (qErr) throw new Error(qErr.message);
        all.push(...((data ?? []) as RecordRow[]));
        if (!data || data.length < 1000) break;
      }
      // Team level title/abstract outcomes decide who needs a PDF.
      const byRecord = new Map<string, { decision: string }[]>();
      for (let from = 0; ; from += 1000) {
        const { data, error: dErr } = await supabase
          .from("screening_decisions")
          .select("record_id, decision")
          .eq("project_id", projectId)
          .eq("stage", "title_abstract")
          .range(from, from + 999);
        if (dErr) throw new Error(dErr.message);
        (data ?? []).forEach((d) => {
          const list = byRecord.get(d.record_id) ?? [];
          list.push(d);
          byRecord.set(d.record_id, list);
        });
        if (!data || data.length < 1000) break;
      }
      const taIncluded = new Set(
        [...byRecord.entries()]
          .filter(([, decs]) => outcomeOf(decs) === "included")
          .map(([id]) => id)
      );
      const needPdf = new Set(
        all
          .filter((r) => taIncluded.has(r.id) && !r.fulltext_path)
          .map((r) => r.id)
      );
      const needAbs = new Set(
        all.filter((r) => !plausibleAbstract(r.abstract)).map((r) => r.id)
      );
      const targets = all.filter(
        (r) => needPdf.has(r.id) || needAbs.has(r.id)
      );
      const withDoi = targets
        .map((r) => ({ r, d: r.norm_doi ?? normalizeDoi(r.doi) }))
        .filter((x): x is { r: RecordRow; d: string } => Boolean(x.d));
      if (withDoi.length === 0) {
        setAbsMsg(
          "Nothing to sweep: every full text record has a PDF and every abstract looks fine (or the remainder has no DOI)."
        );
        setAbsBusy(false);
        return;
      }
      setAbsMsg(`Looking up open access copies for ${withDoi.length} DOIs...`);
      const oaMap = await fetchOaPdfUrls(withDoi.map((x) => x.d));
      const jobs = withDoi.filter((x) => oaMap.has(x.d));
      let attached = 0;
      let absFound = 0;
      for (let i = 0; i < jobs.length; i++) {
        const { r, d } = jobs[i];
        setAbsMsg(
          `Open access: ${i + 1}/${jobs.length} · ${r.title.slice(0, 50)}...`
        );
        try {
          const res = await fetch("/api/oapdf", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              url: oaMap.get(d),
              projectId,
              recordId: r.id,
              attach: needPdf.has(r.id),
              extract: needAbs.has(r.id),
            }),
          });
          if (!res.ok) continue;
          const out = await res.json();
          if (out.attached) attached++;
          if (needAbs.has(r.id) && typeof out.page1 === "string") {
            const abs = abstractFromPdfText(out.page1);
            if (abs) {
              const { error: upErr } = await supabase
                .from("records")
                .update({ abstract: abs })
                .eq("id", r.id);
              if (!upErr) absFound++;
            }
          }
        } catch {
          /* skip this record */
        }
      }
      setAbsMsg(
        `Open access sweep done: ${attached} PDF(s) attached (of ${needPdf.size} full text records without one), ${absFound} abstract(s) extracted from PDFs (of ${needAbs.size} still missing). ${withDoi.length - jobs.length} record(s) had no open access copy; those need manual retrieval or pasting.`
      );
      load();
    } catch (e) {
      setAbsMsg(null);
      setError(e instanceof Error ? e.message : String(e));
    }
    setAbsBusy(false);
  }

  async function deleteRecord(r: RecordRow) {
    const supabase = createClient();
    const ok = window.confirm(
      `Delete "${r.title.slice(0, 60)}..."? Screening decisions on it are removed too. This cannot be undone.`
    );
    if (!ok) return;

    // Was this paper a snowball seed? Offer to cascade to papers that
    // were found only through it. (Query errors before migration 0010;
    // the cascade offer is then simply skipped.)
    let alsoDelete: string[] = [];
    const { data: lk } = await supabase
      .from("snowball_links")
      .select("record_id")
      .eq("seed_record_id", r.id);
    const childIds = [...new Set((lk ?? []).map((l) => l.record_id))];
    if (childIds.length > 0) {
      const viaOthers = new Set<string>();
      for (let i = 0; i < childIds.length; i += 100) {
        const { data: allLk } = await supabase
          .from("snowball_links")
          .select("record_id, seed_record_id")
          .in("record_id", childIds.slice(i, i + 100));
        ((allLk ?? []) as { record_id: string; seed_record_id: string }[]).forEach(
          (l) => {
            if (l.seed_record_id !== r.id) viaOthers.add(l.record_id);
          }
        );
      }
      const exclusive = childIds.filter((id) => !viaOthers.has(id));
      const shared = childIds.length - exclusive.length;
      if (exclusive.length > 0) {
        const cascade = window.confirm(
          `${childIds.length} snowball record(s) were found through this paper, ${exclusive.length} of them through it alone. Also delete those ${exclusive.length}, with their screening decisions?${
            shared > 0
              ? ` The other ${shared} were also found through other seeds and stay either way.`
              : ""
          } Cancel keeps all snowball records.`
        );
        if (cascade) alsoDelete = exclusive;
      }
    }

    const idsToDelete = [r.id, ...alsoDelete];
    const dependents = await collectDependents(projectId, idsToDelete);
    const paths: string[] = r.fulltext_path ? [r.fulltext_path] : [];
    if (alsoDelete.length > 0) {
      for (let i = 0; i < alsoDelete.length; i += 100) {
        const { data: ch } = await supabase
          .from("records")
          .select("fulltext_path")
          .in("id", alsoDelete.slice(i, i + 100));
        ((ch ?? []) as { fulltext_path: string | null }[]).forEach((c) => {
          if (c.fulltext_path) paths.push(c.fulltext_path);
        });
      }
    }
    for (let i = 0; i < idsToDelete.length; i += 100) {
      const { error: delErr } = await supabase
        .from("records")
        .delete()
        .in("id", idsToDelete.slice(i, i + 100));
      if (delErr) {
        setError(delErr.message);
        return;
      }
    }
    await removeFulltextPaths(paths);
    try {
      const repair = await repairDependents(
        projectId,
        dependents,
        new Set(idsToDelete)
      );
      const note = repairSummary(repair);
      if (note) setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    setExpanded(null);
    loadSources();
    load();
  }

  async function setMyDecision(
    r: RecordRow,
    stage: Stage,
    decision: Decision,
    reasonId: string | null
  ) {
    const supabase = createClient();
    const { error: upErr } = await supabase.from("screening_decisions").upsert(
      {
        project_id: projectId,
        record_id: r.id,
        stage,
        decision,
        reason_id: reasonId,
        decided_by: userId,
      },
      { onConflict: "record_id,stage,decided_by" }
    );
    if (upErr) {
      setError(upErr.message);
      return;
    }
    load();
  }

  async function clearMyDecision(r: RecordRow, stage: Stage) {
    const supabase = createClient();
    const { error: delErr } = await supabase
      .from("screening_decisions")
      .delete()
      .eq("record_id", r.id)
      .eq("stage", stage)
      .eq("decided_by", userId);
    if (delErr) {
      setError(delErr.message);
      return;
    }
    load();
  }

  function pickPdf(r: RecordRow) {
    uploadTarget.current = r;
    fileRef.current?.click();
  }

  async function onPdfPicked(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    const target = uploadTarget.current;
    uploadTarget.current = null;
    if (!file || !target) return;
    setUploadBusy(true);
    const err = await uploadFulltext(projectId, target.id, file);
    setUploadBusy(false);
    if (err) {
      setError(err);
      return;
    }
    load();
  }

  async function viewPdf(r: RecordRow) {
    if (!r.fulltext_path) return;
    const res = await signedFulltextUrl(r.fulltext_path);
    if (res.url) window.open(res.url, "_blank", "noopener");
    else if (res.error) setError(res.error);
  }

  async function removePdf(r: RecordRow) {
    if (!r.fulltext_path) return;
    const ok = window.confirm("Remove the stored PDF for this record?");
    if (!ok) return;
    const err = await removeFulltext(r.id, r.fulltext_path);
    if (err) {
      setError(err);
      return;
    }
    load();
  }

  async function toggleRetrieval(r: RecordRow) {
    const supabase = createClient();
    const { error: upErr } = await supabase
      .from("records")
      .update({
        retrieval_status:
          r.retrieval_status === "not_retrieved" ? null : "not_retrieved",
      })
      .eq("id", r.id);
    if (upErr) {
      setError(upErr.message);
      return;
    }
    load();
  }

  async function toggleDuplicate(r: RecordRow) {
    const supabase = createClient();
    const { error: upErr } = await supabase
      .from("records")
      .update({
        status: r.status === "duplicate" ? "active" : "duplicate",
        duplicate_of: null,
      })
      .eq("id", r.id);
    if (upErr) {
      setError(upErr.message);
      return;
    }
    loadSources();
    load();
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const totalDuplicates = sources?.reduce((s, x) => s + x.duplicates, 0) ?? 0;

  const badge = (decision: string) =>
    decision === "include"
      ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200"
      : "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200";

  // E# codes derived from the live reason list, so they always match the
  // numbering shown in the screening room (deleted reasons reset their
  // decisions, so no stale codes can appear).
  const reasonCode = new Map<string, { code: string; label: string }>(
    reasons.map((r, i) => [r.id, { code: `E${i + 1}`, label: r.label }])
  );
  const decisionText = (d: ScreeningDecision) => {
    if (d.decision === "include") return { text: "include", tip: "Included" };
    const rc = d.reason_id ? reasonCode.get(d.reason_id) : null;
    return rc
      ? { text: `exclude: ${rc.code}`, tip: rc.label }
      : { text: "exclude", tip: "Excluded without a specific reason" };
  };

  const decisionRow = (r: RecordRow, stage: Stage) => {
    const map = stage === "full_text" ? ftDecs : taDecs;
    const mine = (map.get(r.id) ?? []).find((d) => d.decided_by === userId);
    const isInc = mine?.decision === "include";
    const isExc = mine?.decision === "exclude";
    return (
      <div className="flex flex-wrap items-center gap-2">
        <span className="w-24 shrink-0 text-xs font-medium text-zinc-500 dark:text-zinc-400">
          {stage === "full_text" ? "Full text:" : "Title/abstract:"}
        </span>
        <button
          onClick={() => setMyDecision(r, stage, "include", null)}
          className={`rounded-full px-3 py-1 text-xs transition-colors ${
            isInc
              ? "bg-emerald-600 text-white"
              : "border border-zinc-300 text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800"
          }`}
        >
          Include
        </button>
        <select
          value={isExc ? (mine?.reason_id ?? "__none") : "__unset"}
          onChange={(e) => {
            const v = e.target.value;
            if (v === "__unset") return;
            setMyDecision(r, stage, "exclude", v === "__none" ? null : v);
          }}
          className={`h-7 rounded-full border px-2 text-xs ${
            isExc
              ? "border-red-400 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300"
              : "border-zinc-300 bg-white text-zinc-600 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400"
          }`}
        >
          <option value="__unset">Exclude with reason...</option>
          {stage !== "full_text" && (
            <option value="__none">Exclude, no reason</option>
          )}
          {reasons.map((re, i) => (
            <option key={re.id} value={re.id}>
              E{i + 1}: {re.label}
            </option>
          ))}
        </select>
        {mine && (
          <button
            onClick={() => clearMyDecision(r, stage)}
            className="text-xs text-zinc-400 underline underline-offset-2 hover:text-zinc-700 dark:hover:text-zinc-300"
          >
            Clear (back to undecided)
          </button>
        )}
      </div>
    );
  };

  const selectCls =
    "h-9 rounded-lg border border-zinc-300 bg-white px-2 text-sm text-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50";
  const inputCls =
    "w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50";
  const linkBtn = "text-xs underline underline-offset-2";

  return (
    <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-8">
      <input
        type="file"
        accept="application/pdf,.pdf"
        ref={fileRef}
        className="hidden"
        onChange={onPdfPicked}
      />
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <h1 className="mr-auto text-2xl font-semibold text-zinc-900 dark:text-zinc-50">
          Records <span className="text-base font-normal text-zinc-400">({total})</span>
        </h1>
        <input
          className="h-9 w-64 rounded-lg border border-zinc-300 bg-white px-3 text-sm text-zinc-900 outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50"
          placeholder="Search titles..."
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(0);
          }}
        />
        <select
          className={selectCls}
          value={status}
          onChange={(e) => {
            setStatus(e.target.value as StatusFilter);
            setPage(0);
          }}
        >
          <option value="active">Active</option>
          <option value="duplicate">Duplicates</option>
          <option value="all">All statuses</option>
        </select>
        <select
          className={selectCls}
          value={decisionFilter}
          onChange={(e) => setDecisionFilter(e.target.value as DecisionFilter)}
        >
          <option value="all">Any decision</option>
          <option value="include">Included</option>
          <option value="exclude">Excluded</option>
          <option value="undecided">Undecided</option>
        </select>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-3 rounded-xl border border-zinc-200 bg-white px-4 py-3 dark:border-zinc-800 dark:bg-zinc-900">
        <button
          onClick={fetchMissingAbstracts}
          disabled={absBusy}
          className="shrink-0 rounded-full border border-zinc-300 px-3 py-1.5 text-xs text-zinc-700 transition-colors hover:bg-zinc-100 disabled:opacity-40 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
        >
          {absBusy ? "Searching..." : "Find missing abstracts"}
        </button>
        <button
          onClick={fetchOaEnrichment}
          disabled={absBusy}
          className="shrink-0 rounded-full border border-zinc-300 px-3 py-1.5 text-xs text-zinc-700 transition-colors hover:bg-zinc-100 disabled:opacity-40 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
        >
          {absBusy ? "Working..." : "Fetch open access PDFs"}
        </button>
        <p className="min-w-0 flex-1 text-sm text-zinc-600 dark:text-zinc-300">
          {absMsg ??
            "Find missing abstracts checks OpenAlex, Semantic Scholar, Crossref, Europe PMC, and OpenAIRE for every record whose abstract is missing or looks like index junk. Fetch open access PDFs attaches free full texts to records that passed title/abstract and pulls abstracts straight from the PDFs of whatever is still missing. The rest is manual: paste in the screening room or via Edit."}
        </p>
      </div>

      {sources !== null && sources.length > 0 && (
        <div className="mb-4 rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
          <div className="mb-2 flex items-center justify-between">
            <p className="text-xs font-semibold uppercase tracking-wide text-zinc-400">
              Sources
            </p>
            <p className="text-xs text-zinc-400">
              {totalDuplicates} duplicates across all sources
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => {
                setSourceFilter("all");
                setPage(0);
              }}
              className={`rounded-full border px-3 py-1.5 text-xs transition-colors ${
                sourceFilter === "all"
                  ? "border-zinc-900 bg-zinc-900 text-zinc-50 dark:border-zinc-50 dark:bg-zinc-50 dark:text-zinc-900"
                  : "border-zinc-300 text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800"
              }`}
            >
              All sources
            </button>
            {sources.map((s) => (
              <span
                key={s.key}
                className={`flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs transition-colors ${
                  sourceFilter === s.key
                    ? "border-zinc-900 bg-zinc-900 text-zinc-50 dark:border-zinc-50 dark:bg-zinc-50 dark:text-zinc-900"
                    : "border-zinc-300 text-zinc-600 dark:border-zinc-700 dark:text-zinc-400"
                }`}
              >
                <button
                  onClick={() => {
                    setSourceFilter(sourceFilter === s.key ? "all" : s.key);
                    setPage(0);
                  }}
                  className="hover:underline"
                  title="Show only records from this source"
                >
                  {s.name}: {s.imported}
                  {s.duplicates > 0 && <> ({s.duplicates} dup)</>}
                </button>
                <button
                  onClick={() => deleteSource(s)}
                  className="opacity-60 hover:opacity-100"
                  title={`Delete all records imported from ${s.name}`}
                  aria-label={`Delete all records from ${s.name}`}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        </div>
      )}

      {error && (
        <p className="mb-4 rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
          {error}
        </p>
      )}

      <BulkPdfUpload
        projectId={projectId}
        onDone={() => {
          loadSources();
          load();
        }}
      />

      <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
        {rows === null ? (
          <p className="px-5 py-4 text-sm text-zinc-500">Loading...</p>
        ) : rows.length === 0 ? (
          <p className="px-5 py-4 text-sm text-zinc-500">
            No records match these filters.
          </p>
        ) : (
          rows.map((r) => {
            const decs = taDecs.get(r.id) ?? [];
            const mine = decs.find((d) => d.decided_by === userId);
            const isOpen = expanded === r.id;
            const isEditing = editingId === r.id && form !== null;
            return (
              <div
                key={r.id}
                className="border-b border-zinc-100 last:border-b-0 dark:border-zinc-800"
              >
                <button
                  onClick={() => {
                    setExpanded(isOpen ? null : r.id);
                    setEditingId(null);
                  }}
                  className="flex w-full items-center gap-3 px-5 py-3 text-left hover:bg-zinc-50 dark:hover:bg-zinc-800/50"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-zinc-900 dark:text-zinc-50">
                      {r.title}
                    </span>
                    {r.authors && (
                      <span className="block truncate text-xs text-zinc-500 dark:text-zinc-400">
                        {r.authors}
                      </span>
                    )}
                  </span>
                  {r.source_label && (
                    <span className="hidden max-w-32 truncate rounded-full bg-zinc-100 px-2 py-0.5 text-xs text-zinc-500 sm:inline dark:bg-zinc-800 dark:text-zinc-400">
                      {r.source_label}
                    </span>
                  )}
                  {r.status === "duplicate" && (
                    <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
                      duplicate
                    </span>
                  )}
                  {r.retrieval_status === "not_retrieved" && (
                    <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
                      no access
                    </span>
                  )}
                  {r.fulltext_path && (
                    <span className="rounded-full bg-sky-100 px-2 py-0.5 text-xs text-sky-700 dark:bg-sky-950 dark:text-sky-300">
                      PDF
                    </span>
                  )}
                  {mine && (
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs ${badge(mine.decision)}`}
                      title={decisionText(mine).tip}
                    >
                      {decisionText(mine).text}
                    </span>
                  )}
                  <span className="w-12 shrink-0 text-right text-xs text-zinc-400">
                    {r.year ?? ""}
                  </span>
                </button>

                {isOpen && !isEditing && (
                  <div className="px-5 pb-4 text-sm">
                    <p className="mb-1 text-zinc-500 dark:text-zinc-400">
                      {[r.authors, r.venue, r.source_label].filter(Boolean).join(" · ")}
                      {r.doi && <> · DOI: {r.doi}</>}
                    </p>
                    {(snowLinks.get(r.id)?.length ?? 0) > 0 && (
                      <p className="mb-1 text-xs text-violet-700 dark:text-violet-300">
                        Snowballed{" "}
                        {(snowLinks.get(r.id) ?? [])
                          .map(
                            (l) =>
                              `${l.direction} from "${(
                                seedTitles.get(l.seedId) ?? "deleted paper"
                              ).slice(0, 70)}"`
                          )
                          .join("; ")}
                      </p>
                    )}
                    {r.abstract && (
                      <p className="mb-2 leading-6 text-zinc-700 dark:text-zinc-300">
                        {r.abstract}
                      </p>
                    )}
                    {decs.length > 0 && (
                      <p className="mb-2 text-xs text-zinc-500 dark:text-zinc-400">
                        Decisions:{" "}
                        {decs
                          .map((d) => {
                            const dt = decisionText(d);
                            const reason =
                              d.decision === "exclude" && d.reason_id
                                ? ` (${reasonCode.get(d.reason_id)?.label ?? "removed reason"})`
                                : "";
                            return `${dt.text}${reason}${d.decided_by === userId ? " (you)" : ""}`;
                          })
                          .join(", ")}
                      </p>
                    )}
                    {r.status === "active" && (
                      <div className="mb-3 flex flex-col gap-2 rounded-lg bg-zinc-50 p-3 dark:bg-zinc-950">
                        {decisionRow(r, "title_abstract")}
                        {outcomeOf(taDecs.get(r.id) ?? []) === "included" && (
                          <>
                            {decisionRow(r, "full_text")}
                            <button
                              onClick={() => toggleRetrieval(r)}
                              className="self-start text-xs text-zinc-400 underline underline-offset-2 hover:text-zinc-700 dark:hover:text-zinc-300"
                            >
                              {r.retrieval_status === "not_retrieved"
                                ? "Marked as full text not retrievable · undo"
                                : "Mark full text not retrievable"}
                            </button>
                          </>
                        )}
                        <div className="flex flex-wrap items-center gap-3 text-xs">
                          <span className="font-medium text-zinc-500 dark:text-zinc-400">
                            PDF:
                          </span>
                          {r.fulltext_path ? (
                            <>
                              <button
                                onClick={() => viewPdf(r)}
                                className="underline underline-offset-2 text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
                              >
                                View
                              </button>
                              <button
                                onClick={() => pickPdf(r)}
                                disabled={uploadBusy}
                                className="underline underline-offset-2 text-zinc-600 hover:text-zinc-900 disabled:opacity-50 dark:text-zinc-400 dark:hover:text-zinc-100"
                              >
                                Replace
                              </button>
                              <button
                                onClick={() => removePdf(r)}
                                className="underline underline-offset-2 text-zinc-400 hover:text-red-600"
                              >
                                Remove
                              </button>
                            </>
                          ) : (
                            <button
                              onClick={() => pickPdf(r)}
                              disabled={uploadBusy}
                              className="underline underline-offset-2 text-zinc-600 hover:text-zinc-900 disabled:opacity-50 dark:text-zinc-400 dark:hover:text-zinc-100"
                            >
                              {uploadBusy ? "Uploading..." : "Upload full text PDF"}
                            </button>
                          )}
                        </div>
                      </div>
                    )}
                    <div className="flex gap-4">
                      <button
                        onClick={() => startEdit(r)}
                        className={`${linkBtn} text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200`}
                      >
                        Edit
                      </button>
                      <button
                        onClick={() => toggleDuplicate(r)}
                        className={`${linkBtn} text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200`}
                      >
                        {r.status === "duplicate" ? "Mark as unique" : "Mark as duplicate"}
                      </button>
                      <button
                        onClick={() => deleteRecord(r)}
                        className={`${linkBtn} text-zinc-400 hover:text-red-600`}
                      >
                        Delete record
                      </button>
                    </div>
                  </div>
                )}

                {isOpen && isEditing && form && (
                  <div className="flex flex-col gap-2 px-5 pb-4 text-sm">
                    <input
                      className={inputCls}
                      value={form.title}
                      onChange={(e) => setForm({ ...form, title: e.target.value })}
                      placeholder="Title"
                    />
                    <div className="grid gap-2 sm:grid-cols-2">
                      <input
                        className={inputCls}
                        value={form.authors}
                        onChange={(e) => setForm({ ...form, authors: e.target.value })}
                        placeholder="Authors"
                      />
                      <input
                        className={inputCls}
                        value={form.venue}
                        onChange={(e) => setForm({ ...form, venue: e.target.value })}
                        placeholder="Venue"
                      />
                      <input
                        className={inputCls}
                        value={form.year}
                        onChange={(e) => setForm({ ...form, year: e.target.value })}
                        placeholder="Year"
                      />
                      <input
                        className={inputCls}
                        value={form.doi}
                        onChange={(e) => setForm({ ...form, doi: e.target.value })}
                        placeholder="DOI"
                      />
                    </div>
                    <input
                      className={inputCls}
                      value={form.url}
                      onChange={(e) => setForm({ ...form, url: e.target.value })}
                      placeholder="URL"
                    />
                    <textarea
                      className={`${inputCls} min-h-24`}
                      value={form.abstract}
                      onChange={(e) => setForm({ ...form, abstract: e.target.value })}
                      placeholder="Abstract"
                    />
                    <div className="flex gap-3">
                      <button
                        onClick={() => saveEdit(r.id)}
                        disabled={saving || !form.title.trim()}
                        className="rounded-full bg-zinc-900 px-4 py-1.5 text-xs font-medium text-zinc-50 disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-900"
                      >
                        {saving ? "Saving..." : "Save changes"}
                      </button>
                      <button
                        onClick={() => {
                          setEditingId(null);
                          setForm(null);
                        }}
                        className={`${linkBtn} text-zinc-400`}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      <div className="mt-4 flex items-center justify-between text-sm text-zinc-500 dark:text-zinc-400">
        <button
          disabled={page === 0}
          onClick={() => setPage((p) => p - 1)}
          className="rounded-full border border-zinc-300 px-4 py-1.5 disabled:opacity-40 dark:border-zinc-700"
        >
          Previous
        </button>
        <span>
          Page {page + 1} of {totalPages}
        </span>
        <button
          disabled={page + 1 >= totalPages}
          onClick={() => setPage((p) => p + 1)}
          className="rounded-full border border-zinc-300 px-4 py-1.5 disabled:opacity-40 dark:border-zinc-700"
        >
          Next
        </button>
      </div>
    </main>
  );
}
