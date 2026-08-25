"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { decisionsByRecord, outcomeOf } from "@/lib/outcomes";
import { signedFulltextUrl } from "@/lib/fulltext";
import { buildAnchor, findAnchor, snapToWords } from "@/lib/anchors";
import { cleanQuote } from "@/lib/concepts";
import type {
  Concept,
  ConceptExcerpt,
  ConceptTag,
  Project,
  RecordRow,
} from "@/lib/types";
import type { PDFDocumentProxy } from "pdfjs-dist";

/**
 * The reading room: Webster and Watson concept coding done directly in
 * the paper. The PDF renders with a selectable text layer; selecting a
 * passage opens the concept picker, and the saved excerpt becomes a
 * highlight every team member sees (anchored by page + character
 * offsets + surrounding context, so it re-attaches robustly). The
 * right rail is this paper's live concept column.
 */

// ----------------------------------------------------------------------
// Concept colors: a fixed palette assigned by concept order. Alpha low
// enough that black text stays readable through the highlight.
// ----------------------------------------------------------------------
const HUES = [45, 200, 140, 275, 15, 320, 175, 235, 90, 355, 60, 300];
function conceptColor(index: number): { fill: string; dot: string } {
  const h = HUES[index % HUES.length];
  // Later laps around the palette get a deeper tone so 13th+ concepts
  // stay distinguishable from their hue twins.
  const l = index < HUES.length ? 55 : 40;
  return {
    fill: `hsla(${h}, 85%, ${l}%, 0.28)`,
    dot: `hsl(${h}, 70%, ${Math.min(l, 45)}%)`,
  };
}

/** Character offset of a DOM boundary point inside root (text layer). */
function pointToOffset(
  root: HTMLElement,
  node: Node,
  offset: number
): number | null {
  if (node !== root && !root.contains(node)) return null;
  const r = document.createRange();
  r.setStart(root, 0);
  try {
    r.setEnd(node, offset);
  } catch {
    return null;
  }
  return r.toString().length;
}

/** Inverse of pointToOffset: the text node + local offset at `offset`. */
function offsetToPoint(
  root: HTMLElement,
  offset: number
): { node: Node; offset: number } | null {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let total = 0;
  for (let cur = walker.nextNode(); cur; cur = walker.nextNode()) {
    const len = (cur as Text).data.length;
    if (offset <= total + len) return { node: cur, offset: offset - total };
    total += len;
  }
  return null;
}

type HighlightRect = {
  top: number;
  left: number;
  width: number;
  height: number;
  excerptId: string;
  fill: string;
  title: string;
};

/** One page's share of a selection; a selection spanning a page break
 * carries one part per page and saves one anchored excerpt per part. */
type SelPart = {
  page: number;
  start: number;
  end: number;
  quote: string;
};

type Sel = {
  parts: SelPart[];
  x: number;
  y: number;
};

// ----------------------------------------------------------------------
// One PDF page: canvas + text layer + highlight overlay.
// ----------------------------------------------------------------------
function PageView({
  doc,
  pageNo,
  scale,
  excerpts,
  conceptIndex,
  conceptLabel,
  authorName,
  flashId,
  pending,
  onTextReady,
  onPickExcerpt,
  registerEl,
}: {
  doc: PDFDocumentProxy;
  pageNo: number;
  scale: number;
  excerpts: ConceptExcerpt[];
  conceptIndex: Map<string, number>;
  conceptLabel: Map<string, string>;
  authorName: (id: string | null) => string;
  flashId: string | null;
  pending: { start: number; end: number } | null;
  onTextReady: (pageNo: number, text: string) => void;
  onPickExcerpt: (id: string) => void;
  registerEl: (pageNo: number, el: HTMLDivElement | null) => void;
}) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const textRef = useRef<HTMLDivElement | null>(null);
  const [pageText, setPageText] = useState<string | null>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [rects, setRects] = useState<HighlightRect[]>([]);
  const [pendingRects, setPendingRects] = useState<
    { top: number; left: number; width: number; height: number }[]
  >([]);

  // Render the page once (canvas + text layer), then report its text.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const pdfjs = await import("pdfjs-dist");
      const page = await doc.getPage(pageNo);
      if (cancelled) return;
      const viewport = page.getViewport({ scale });
      const canvas = canvasRef.current;
      const textDiv = textRef.current;
      if (!canvas || !textDiv) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.floor(viewport.width * dpr);
      canvas.height = Math.floor(viewport.height * dpr);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      setSize({ w: viewport.width, h: viewport.height });
      await page.render({
        canvas,
        viewport,
        transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
      }).promise;
      if (cancelled) return;
      textDiv.textContent = "";
      const textContent = await page.getTextContent();
      if (cancelled) return;
      const layer = new pdfjs.TextLayer({
        textContentSource: textContent,
        container: textDiv,
        viewport,
      });
      await layer.render();
      if (cancelled) return;
      // Canonical page text: concatenation of the text layer's nodes,
      // the same string offsets are computed against everywhere.
      const r = document.createRange();
      r.selectNodeContents(textDiv);
      const text = r.toString();
      setPageText(text);
      onTextReady(pageNo, text);
    })().catch(() => {
      /* page render failures leave the page blank; the PDF may still
         be readable via download from the records table */
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, pageNo, scale]);

  // Paint highlights whenever the page text or the excerpts change.
  useEffect(() => {
    const textDiv = textRef.current;
    const wrap = wrapRef.current;
    if (!textDiv || !wrap || pageText === null) return;
    const wrapBox = wrap.getBoundingClientRect();
    const out: HighlightRect[] = [];
    for (const ex of excerpts) {
      if (ex.pos_start == null || ex.pos_end == null) continue;
      const hit = findAnchor(pageText, {
        quote: ex.quote,
        pos_start: ex.pos_start,
        pos_end: ex.pos_end,
        prefix: ex.prefix ?? "",
        suffix: ex.suffix ?? "",
      });
      if (!hit) continue;
      const from = offsetToPoint(textDiv, hit.start);
      const to = offsetToPoint(textDiv, hit.end);
      if (!from || !to) continue;
      const range = document.createRange();
      try {
        range.setStart(from.node, from.offset);
        range.setEnd(to.node, to.offset);
      } catch {
        continue;
      }
      const idx = conceptIndex.get(ex.concept_id) ?? 0;
      const label = conceptLabel.get(ex.concept_id) ?? "concept";
      for (const cr of range.getClientRects()) {
        if (cr.width < 1 || cr.height < 1) continue;
        out.push({
          top: cr.top - wrapBox.top,
          left: cr.left - wrapBox.left,
          width: cr.width,
          height: cr.height,
          excerptId: ex.id,
          fill: conceptColor(idx).fill,
          title: `${label} · ${authorName(ex.added_by)}`,
        });
      }
    }
    setRects(out);
  }, [pageText, excerpts, conceptIndex, conceptLabel, authorName]);

  // The pending overlay: marks the active selection so it stays
  // visible after the concept picker takes keyboard focus (focusing an
  // input clears the browser's own selection painting).
  useEffect(() => {
    const out: { top: number; left: number; width: number; height: number }[] =
      [];
    const textDiv = textRef.current;
    const wrap = wrapRef.current;
    if (textDiv && wrap && pageText !== null && pending) {
      const from = offsetToPoint(textDiv, pending.start);
      const to = offsetToPoint(textDiv, pending.end);
      if (from && to) {
        const range = document.createRange();
        try {
          range.setStart(from.node, from.offset);
          range.setEnd(to.node, to.offset);
          const wrapBox = wrap.getBoundingClientRect();
          for (const cr of range.getClientRects()) {
            if (cr.width < 1 || cr.height < 1) continue;
            out.push({
              top: cr.top - wrapBox.top,
              left: cr.left - wrapBox.left,
              width: cr.width,
              height: cr.height,
            });
          }
        } catch {
          // Unmappable offsets: no pending overlay for this page.
        }
      }
    }
    // Derived from DOM geometry after render, like the highlight rects.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPendingRects(out);
  }, [pending, pageText]);

  return (
    <div
      ref={(el) => {
        wrapRef.current = el;
        registerEl(pageNo, el);
      }}
      className="relative mx-auto mb-4 bg-white shadow-sm dark:shadow-none"
      style={
        {
          width: size?.w,
          height: size?.h,
          "--scale-factor": scale,
          "--total-scale-factor": scale,
        } as React.CSSProperties
      }
    >
      <canvas ref={canvasRef} className="absolute left-0 top-0 select-none" />
      {/* Highlights sit between the canvas and the text layer. */}
      <div className="pointer-events-none absolute left-0 top-0 h-full w-full select-none">
        {pendingRects.map((r, i) => (
          <div
            key={`p${i}`}
            className="absolute rounded-[2px] bg-teal-500/25 ring-1 ring-teal-600/60"
            style={{
              top: r.top,
              left: r.left,
              width: r.width,
              height: r.height,
            }}
          />
        ))}
        {rects.map((r, i) => (
          <div
            key={i}
            title={r.title}
            onClick={() => onPickExcerpt(r.excerptId)}
            className={`pointer-events-auto absolute cursor-pointer rounded-[2px] ${
              flashId === r.excerptId ? "ring-2 ring-teal-600" : ""
            }`}
            style={{
              top: r.top,
              left: r.left,
              width: r.width,
              height: r.height,
              backgroundColor: r.fill,
              mixBlendMode: "multiply",
            }}
          />
        ))}
      </div>
      <div ref={textRef} className="textLayer" />
    </div>
  );
}

// ----------------------------------------------------------------------
// The reading room itself.
// ----------------------------------------------------------------------
export default function ReadClient({
  project,
  userId,
}: {
  project: Project;
  userId: string;
}) {
  const [papers, setPapers] = useState<RecordRow[] | null>(null);
  const [recIdx, setRecIdx] = useState(0);
  const [concepts, setConcepts] = useState<Concept[]>([]);
  const [tags, setTags] = useState<ConceptTag[]>([]);
  const [excerpts, setExcerpts] = useState<ConceptExcerpt[]>([]);
  const [names, setNames] = useState<Map<string, string>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [numPages, setNumPages] = useState(0);
  const [scale, setScale] = useState(1.3);
  const [pdfBusy, setPdfBusy] = useState(false);
  const pageTexts = useRef<Map<number, string>>(new Map());
  const pageEls = useRef<Map<number, HTMLDivElement | null>>(new Map());
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const fitScaleRef = useRef(1.3);

  const [sel, setSel] = useState<Sel | null>(null);
  const [pickerQuery, setPickerQuery] = useState("");
  const [saving, setSaving] = useState(false);
  const [flashId, setFlashId] = useState<string | null>(null);
  const [newConcept, setNewConcept] = useState("");

  const current = papers && papers.length > 0 ? papers[Math.min(recIdx, papers.length - 1)] : null;

  // ------------------------------------------------------------------
  // Data loading
  // ------------------------------------------------------------------
  const load = useCallback(async () => {
    const supabase = createClient();
    try {
      // All stage decisions, to derive the FT included reading list.
      const decs: { record_id: string; stage: string; decision: string }[] = [];
      for (let from = 0; ; from += 1000) {
        const { data, error: dErr } = await supabase
          .from("screening_decisions")
          .select("record_id, stage, decision")
          .eq("project_id", project.id)
          .range(from, from + 999);
        if (dErr) throw new Error(dErr.message);
        decs.push(...(data ?? []));
        if (!data || data.length < 1000) break;
      }
      const taMap = decisionsByRecord(decs, "title_abstract");
      const ftMap = decisionsByRecord(decs, "full_text");
      const includedIds = [...taMap.entries()]
        .filter(([id, ta]) =>
          outcomeOf(ta) === "included" &&
          outcomeOf(ftMap.get(id) ?? []) === "included"
        )
        .map(([id]) => id);

      const recs: RecordRow[] = [];
      for (let i = 0; i < includedIds.length; i += 100) {
        const { data } = await supabase
          .from("records")
          .select("*")
          .eq("project_id", project.id)
          .eq("status", "active")
          .in("id", includedIds.slice(i, i + 100));
        recs.push(...((data ?? []) as RecordRow[]));
      }
      recs.sort((a, b) => a.title.localeCompare(b.title));

      const [cRes, tRes, eRes, mRes] = await Promise.all([
        supabase
          .from("concepts")
          .select("*")
          .eq("project_id", project.id)
          .order("position")
          .order("created_at"),
        supabase.from("concept_tags").select("*").eq("project_id", project.id),
        supabase
          .from("concept_excerpts")
          .select("*")
          .eq("project_id", project.id)
          .order("page")
          .order("created_at"),
        supabase
          .from("project_members")
          .select("user_id, profiles(display_name, email)")
          .eq("project_id", project.id),
      ]);
      const nameMap = new Map<string, string>();
      (
        (mRes.data ?? []) as unknown as {
          user_id: string;
          profiles:
            | { display_name: string | null; email: string | null }
            | { display_name: string | null; email: string | null }[]
            | null;
        }[]
      ).forEach((m) => {
        const p = Array.isArray(m.profiles) ? m.profiles[0] : m.profiles;
        nameMap.set(m.user_id, p?.display_name || p?.email || "Member");
      });

      setPapers(recs);
      setConcepts((cRes.data ?? []) as Concept[]);
      setTags((tRes.data ?? []) as ConceptTag[]);
      setExcerpts((eRes.data ?? []) as ConceptExcerpt[]);
      setNames(nameMap);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [project.id]);

  useEffect(() => {
    // Fetch-on-mount: state updates happen after awaits inside load().
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  // ------------------------------------------------------------------
  // PDF loading per paper
  // ------------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    let opened: PDFDocumentProxy | null = null;
    pageTexts.current = new Map();
    pageEls.current = new Map();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDoc(null);
    setNumPages(0);
    setSel(null);
    if (!current?.fulltext_path) return;
    setPdfBusy(true);
    (async () => {
      const pdfjs = await import("pdfjs-dist");
      if (!pdfjs.GlobalWorkerOptions.workerSrc) {
        pdfjs.GlobalWorkerOptions.workerSrc = new URL(
          "pdfjs-dist/build/pdf.worker.min.mjs",
          import.meta.url
        ).toString();
      }
      const { url, error: uErr } = await signedFulltextUrl(current.fulltext_path!);
      if (uErr || !url) throw new Error(uErr ?? "No PDF link.");
      const res = await fetch(url);
      if (!res.ok) throw new Error(`PDF download failed (${res.status}).`);
      const buf = await res.arrayBuffer();
      if (cancelled) return;
      const d = await pdfjs.getDocument({ data: new Uint8Array(buf) }).promise;
      if (cancelled) {
        d.loadingTask.destroy();
        return;
      }
      opened = d;
      // Fit width: size pages to the viewport column.
      const first = await d.getPage(1);
      const w = viewportRef.current?.clientWidth ?? 800;
      const base = first.getViewport({ scale: 1 });
      const fit = Math.min(2, Math.max(0.6, (w - 24) / base.width));
      if (cancelled) return;
      fitScaleRef.current = fit;
      setScale(fit);
      setDoc(d);
      setNumPages(d.numPages);
      setError(null);
    })()
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setPdfBusy(false);
      });
    return () => {
      cancelled = true;
      opened?.loadingTask.destroy();
    };
     
  }, [current?.id, current?.fulltext_path]);

  // ------------------------------------------------------------------
  // Derived maps
  // ------------------------------------------------------------------
  const conceptIndex = useMemo(
    () => new Map(concepts.map((c, i) => [c.id, i])),
    [concepts]
  );
  const conceptLabel = useMemo(
    () => new Map(concepts.map((c) => [c.id, c.label])),
    [concepts]
  );
  const authorName = useCallback(
    (id: string | null) => (id ? (names.get(id) ?? "Member") : "Member"),
    [names]
  );
  const paperExcerpts = useMemo(
    () =>
      excerpts
        .filter((e) => e.record_id === current?.id)
        .sort(
          (a, b) =>
            (a.page ?? 0) - (b.page ?? 0) ||
            (a.pos_start ?? 0) - (b.pos_start ?? 0)
        ),
    [excerpts, current?.id]
  );
  const excerptsByPage = useMemo(() => {
    const m = new Map<number, ConceptExcerpt[]>();
    paperExcerpts.forEach((e) => {
      if (e.page == null || e.pos_start == null) return;
      const list = m.get(e.page) ?? [];
      list.push(e);
      m.set(e.page, list);
    });
    return m;
  }, [paperExcerpts]);
  const countByConcept = useMemo(() => {
    const m = new Map<string, number>();
    paperExcerpts.forEach((e) =>
      m.set(e.concept_id, (m.get(e.concept_id) ?? 0) + 1)
    );
    return m;
  }, [paperExcerpts]);
  const taggedConcepts = useMemo(
    () =>
      new Set(
        tags.filter((t) => t.record_id === current?.id).map((t) => t.concept_id)
      ),
    [tags, current?.id]
  );

  const onTextReady = useCallback((pageNo: number, text: string) => {
    pageTexts.current.set(pageNo, text);
  }, []);
  const registerEl = useCallback((pageNo: number, el: HTMLDivElement | null) => {
    pageEls.current.set(pageNo, el);
  }, []);

  // ------------------------------------------------------------------
  // Selection: handled at the viewport level so a drag across a page
  // break still works — each page contributes its own part, clamped to
  // its share of the selection and snapped to word boundaries.
  // ------------------------------------------------------------------
  function handleViewportMouseUp(e: React.MouseEvent) {
    if (!doc) return;
    const s = window.getSelection();
    if (!s || s.isCollapsed || s.rangeCount === 0) return;
    const range = s.getRangeAt(0);
    const parts: SelPart[] = [];
    for (const [pageNo, wrap] of pageEls.current) {
      if (!wrap) continue;
      const textDiv = wrap.querySelector(".textLayer") as HTMLElement | null;
      const pageText = pageTexts.current.get(pageNo);
      if (!textDiv || pageText == null || pageText.length === 0) continue;
      if (!range.intersectsNode(textDiv)) continue;
      const startIn =
        textDiv === range.startContainer || textDiv.contains(range.startContainer);
      const endIn =
        textDiv === range.endContainer || textDiv.contains(range.endContainer);
      const rawStart = startIn
        ? pointToOffset(textDiv, range.startContainer, range.startOffset)
        : 0;
      const rawEnd = endIn
        ? pointToOffset(textDiv, range.endContainer, range.endOffset)
        : pageText.length;
      if (rawStart === null || rawEnd === null || rawStart >= rawEnd) continue;
      const { start, end } = snapToWords(pageText, rawStart, rawEnd);
      if (start >= end) continue;
      const quote = pageText.slice(start, end);
      if (!quote.trim()) continue;
      parts.push({ page: pageNo, start, end, quote });
    }
    parts.sort((a, b) => a.page - b.page);
    if (parts.length === 0) return;
    const totalLen = parts.reduce((n, p) => n + p.quote.length, 0);
    if (parts.length > 3 || totalLen > 4000) {
      setNotice("That selection is very long — pick a tighter passage.");
      window.setTimeout(() => setNotice(null), 2500);
      return;
    }
    setSel({ parts, x: e.clientX, y: e.clientY });
  }

  // ------------------------------------------------------------------
  // Saving excerpts
  // ------------------------------------------------------------------
  async function saveSelection(concept: Concept) {
    if (!sel || !current || saving) return;
    // One anchored excerpt per page the selection touches.
    const rows = sel.parts.flatMap((part) => {
      const pageText = pageTexts.current.get(part.page);
      const anchor = pageText
        ? buildAnchor(pageText, part.start, part.end)
        : null;
      if (!anchor) return [];
      return [
        {
          project_id: project.id,
          concept_id: concept.id,
          record_id: current.id,
          quote: anchor.quote,
          page: part.page,
          pos_start: anchor.pos_start,
          pos_end: anchor.pos_end,
          prefix: anchor.prefix,
          suffix: anchor.suffix,
          added_by: userId,
        },
      ];
    });
    if (rows.length === 0) return;
    setSaving(true);
    const supabase = createClient();
    const { data: inserted, error: insErr } = await supabase
      .from("concept_excerpts")
      .insert(rows)
      .select("*");
    if (insErr || !inserted || inserted.length === 0) {
      setSaving(false);
      setError(
        insErr?.message.includes("pos_start")
          ? "Run migration 0015_excerpt_anchors.sql in the Supabase SQL Editor to enable highlights."
          : (insErr?.message ?? "Could not save the excerpt.")
      );
      return;
    }
    // The checkmark: make sure the paper carries this concept's tag.
    const { error: tagErr } = await supabase.from("concept_tags").upsert(
      {
        project_id: project.id,
        concept_id: concept.id,
        record_id: current.id,
        tagged_by: userId,
      },
      { onConflict: "concept_id,record_id", ignoreDuplicates: true }
    );
    setSaving(false);
    if (tagErr) {
      setError(tagErr.message);
      return;
    }
    setExcerpts((xs) => [...xs, ...(inserted as ConceptExcerpt[])]);
    setTags((ts) =>
      ts.some(
        (t) => t.concept_id === concept.id && t.record_id === current.id
      )
        ? ts
        : [
            ...ts,
            {
              id: `local-${inserted[0].id}`,
              project_id: project.id,
              concept_id: concept.id,
              record_id: current.id,
              unit: null,
              note: null,
              tagged_by: userId,
              created_at: new Date().toISOString(),
            },
          ]
    );
    setSel(null);
    setPickerQuery("");
    window.getSelection()?.removeAllRanges();
    setNotice(`Tagged "${concept.label}".`);
    window.setTimeout(() => setNotice(null), 1800);
  }

  async function createConceptAndSave(label: string) {
    if (!label.trim() || saving) return;
    setSaving(true);
    const supabase = createClient();
    const { data, error: cErr } = await supabase
      .from("concepts")
      .insert({
        project_id: project.id,
        label: label.trim(),
        position: concepts.length,
        created_by: userId,
      })
      .select("*")
      .single();
    setSaving(false);
    if (cErr || !data) {
      setError(cErr?.message ?? "Could not create the concept.");
      return;
    }
    const concept = data as Concept;
    setConcepts((cs) => [...cs, concept]);
    if (sel) await saveSelection(concept);
  }

  async function addConceptOnly() {
    const label = newConcept.trim();
    if (!label) return;
    setNewConcept("");
    const supabase = createClient();
    const { data, error: cErr } = await supabase
      .from("concepts")
      .insert({
        project_id: project.id,
        label,
        position: concepts.length,
        created_by: userId,
      })
      .select("*")
      .single();
    if (cErr || !data) {
      setError(cErr?.message ?? "Could not create the concept.");
      return;
    }
    setConcepts((cs) => [...cs, data as Concept]);
  }

  async function deleteExcerpt(ex: ConceptExcerpt) {
    const supabase = createClient();
    const { error: delErr } = await supabase
      .from("concept_excerpts")
      .delete()
      .eq("id", ex.id);
    if (delErr) {
      setError(delErr.message);
      return;
    }
    setExcerpts((xs) => xs.filter((x) => x.id !== ex.id));
  }

  function jumpToExcerpt(ex: ConceptExcerpt) {
    if (ex.page != null) {
      pageEls.current
        .get(ex.page)
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
    }
    setFlashId(ex.id);
    window.setTimeout(() => setFlashId((f) => (f === ex.id ? null : f)), 2000);
  }

  function jumpToConcept(conceptId: string) {
    const first = paperExcerpts.find(
      (e) => e.concept_id === conceptId && e.page != null
    );
    if (first) jumpToExcerpt(first);
  }

  // ------------------------------------------------------------------
  // Rendering
  // ------------------------------------------------------------------
  const filteredConcepts = useMemo(() => {
    const q = pickerQuery.trim().toLowerCase();
    if (!q) return concepts;
    return concepts.filter((c) => c.label.toLowerCase().includes(q));
  }, [concepts, pickerQuery]);
  const exactMatch = concepts.some(
    (c) => c.label.toLowerCase() === pickerQuery.trim().toLowerCase()
  );

  const railBtn =
    "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition-colors hover:bg-zinc-100 dark:hover:bg-zinc-800";

  return (
    <main className="mx-auto flex w-full max-w-[1800px] flex-1 flex-col px-4 py-4">
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-50">
          Reading room
        </h1>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Select text in the paper to tag a concept; highlights are shared
          with the whole team. The matrix on the Concepts page builds
          itself from what you tag here.
        </p>
      </div>

      {error && (
        <p className="mb-3 rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
          {error}
        </p>
      )}

      {papers === null ? (
        <p className="text-zinc-600 dark:text-zinc-400">Loading...</p>
      ) : papers.length === 0 ? (
        <div className="rounded-xl border border-zinc-200 bg-white p-6 text-sm text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
          The reading list holds the studies included after full text
          screening, and none exist yet. Finish full text screening first;
          included papers appear here automatically.
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 gap-4">
          {/* ---------------- Paper viewport ---------------- */}
          <div
            ref={viewportRef}
            onMouseUp={handleViewportMouseUp}
            className="relative min-w-0 flex-1 overflow-y-auto rounded-xl border border-zinc-200 bg-zinc-100 p-3 dark:border-zinc-800 dark:bg-zinc-950"
            style={{ maxHeight: "calc(100vh - 170px)" }}
          >
            {!current?.fulltext_path ? (
              <div className="mx-auto max-w-xl rounded-xl border border-zinc-200 bg-white p-6 text-sm leading-6 text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300">
                <p className="mb-2 font-medium text-zinc-900 dark:text-zinc-50">
                  No PDF attached to this paper yet.
                </p>
                <p className="mb-3">
                  Attach one in the{" "}
                  <Link
                    href={`/projects/${project.id}/records`}
                    className="underline underline-offset-2"
                  >
                    records table
                  </Link>{" "}
                  (upload or the open access sweep), or paste quotes by hand
                  on the{" "}
                  <Link
                    href={`/projects/${project.id}/concepts`}
                    className="underline underline-offset-2"
                  >
                    Concepts page
                  </Link>
                  .
                </p>
                {current?.abstract && (
                  <p className="border-t border-zinc-100 pt-3 text-zinc-600 dark:border-zinc-800 dark:text-zinc-400">
                    {current.abstract}
                  </p>
                )}
              </div>
            ) : pdfBusy || !doc ? (
              <p className="p-6 text-sm text-zinc-600 dark:text-zinc-400">
                Loading PDF...
              </p>
            ) : (
              <>
              <div className="sticky top-0 z-10 mb-2 flex justify-end">
                <div className="flex items-center gap-1 rounded-full border border-zinc-200 bg-white px-2 py-1 shadow-sm dark:border-zinc-700 dark:bg-zinc-900">
                  <button
                    onClick={() =>
                      setScale((s) => Math.max(0.5, Math.round((s / 1.2) * 100) / 100))
                    }
                    className="rounded-full px-2 text-sm text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
                    title="Zoom out"
                  >
                    −
                  </button>
                  <span className="w-12 text-center text-xs tabular-nums text-zinc-600 dark:text-zinc-400">
                    {Math.round(scale * 100)}%
                  </span>
                  <button
                    onClick={() =>
                      setScale((s) => Math.min(3, Math.round(s * 1.2 * 100) / 100))
                    }
                    className="rounded-full px-2 text-sm text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
                    title="Zoom in (larger text is easier to select precisely)"
                  >
                    +
                  </button>
                  <button
                    onClick={() => setScale(fitScaleRef.current)}
                    className="rounded-full px-2 text-xs text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
                    title="Fit page width"
                  >
                    Fit
                  </button>
                </div>
              </div>
              {Array.from({ length: numPages }, (_, i) => i + 1).map((n) => (
                <PageView
                  key={`${current.id}-${n}`}
                  doc={doc}
                  pageNo={n}
                  scale={scale}
                  excerpts={excerptsByPage.get(n) ?? []}
                  conceptIndex={conceptIndex}
                  conceptLabel={conceptLabel}
                  authorName={authorName}
                  flashId={flashId}
                  pending={sel?.parts.find((p) => p.page === n) ?? null}
                  onTextReady={onTextReady}
                  onPickExcerpt={(id) => {
                    const ex = excerpts.find((x) => x.id === id);
                    if (ex) jumpToExcerpt(ex);
                  }}
                  registerEl={registerEl}
                />
              ))}
              </>
            )}
          </div>

          {/* ---------------- Concept rail ---------------- */}
          <aside className="flex w-80 shrink-0 flex-col gap-3">
            <div className="rounded-xl border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900">
              <div className="mb-1 flex items-center justify-between gap-2">
                <button
                  onClick={() => setRecIdx((i) => Math.max(0, i - 1))}
                  disabled={recIdx === 0}
                  className="rounded-full border border-zinc-300 px-2.5 py-1 text-sm text-zinc-700 disabled:opacity-40 dark:border-zinc-700 dark:text-zinc-300"
                >
                  ←
                </button>
                <span className="text-sm tabular-nums text-zinc-600 dark:text-zinc-400">
                  {Math.min(recIdx, papers.length - 1) + 1} / {papers.length}
                </span>
                <button
                  onClick={() =>
                    setRecIdx((i) => Math.min(papers.length - 1, i + 1))
                  }
                  disabled={recIdx >= papers.length - 1}
                  className="rounded-full border border-zinc-300 px-2.5 py-1 text-sm text-zinc-700 disabled:opacity-40 dark:border-zinc-700 dark:text-zinc-300"
                >
                  →
                </button>
              </div>
              <select
                value={Math.min(recIdx, papers.length - 1)}
                onChange={(e) => setRecIdx(parseInt(e.target.value, 10))}
                className="mb-1 w-full rounded-lg border border-zinc-300 bg-white px-2 py-1.5 text-sm text-zinc-900 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50"
              >
                {papers.map((p, i) => (
                  <option key={p.id} value={i}>
                    {p.title.slice(0, 70)}
                  </option>
                ))}
              </select>
              {current && (
                <p className="text-xs text-zinc-500 dark:text-zinc-400">
                  {[current.authors, current.year].filter(Boolean).join(" · ")}
                </p>
              )}
            </div>

            <div className="flex min-h-0 flex-1 flex-col overflow-y-auto rounded-xl border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900">
              <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                This paper&apos;s column
              </p>
              {concepts.length === 0 && (
                <p className="mb-2 text-sm text-zinc-600 dark:text-zinc-400">
                  No concepts yet. Select text in the paper, or add one
                  below; concepts emerge as you read.
                </p>
              )}
              {concepts.map((c, i) => {
                const n = countByConcept.get(c.id) ?? 0;
                const tagged = taggedConcepts.has(c.id);
                return (
                  <button
                    key={c.id}
                    onClick={() => jumpToConcept(c.id)}
                    className={railBtn}
                    title={
                      n > 0
                        ? "Jump to the first highlight"
                        : tagged
                          ? "Tagged without a highlight in this paper"
                          : "Not evidenced in this paper yet"
                    }
                  >
                    <span
                      className="h-3 w-3 shrink-0 rounded-full"
                      style={{ backgroundColor: conceptColor(i).dot }}
                    />
                    <span
                      className={`min-w-0 flex-1 truncate ${
                        n > 0 || tagged
                          ? "text-zinc-900 dark:text-zinc-50"
                          : "text-zinc-500 dark:text-zinc-500"
                      }`}
                    >
                      {c.label}
                    </span>
                    <span className="text-xs tabular-nums text-zinc-500 dark:text-zinc-400">
                      {n > 0 ? `✓ ${n}` : tagged ? "✓" : "·"}
                    </span>
                  </button>
                );
              })}
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  addConceptOnly();
                }}
                className="mt-2 flex gap-1.5"
              >
                <input
                  value={newConcept}
                  onChange={(e) => setNewConcept(e.target.value)}
                  placeholder="Add concept..."
                  className="h-8 min-w-0 flex-1 rounded-lg border border-zinc-300 bg-white px-2 text-sm text-zinc-900 outline-none focus:border-teal-600 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50"
                />
                <button
                  type="submit"
                  disabled={!newConcept.trim()}
                  className="rounded-full border border-zinc-300 px-3 text-sm text-zinc-700 disabled:opacity-40 dark:border-zinc-700 dark:text-zinc-300"
                >
                  Add
                </button>
              </form>

              <p className="mb-1 mt-4 text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                Evidence in this paper ({paperExcerpts.length})
              </p>
              {paperExcerpts.length === 0 && (
                <p className="text-sm text-zinc-500 dark:text-zinc-500">
                  Highlights you and your teammates save appear here.
                </p>
              )}
              {paperExcerpts.map((ex) => {
                const i = conceptIndex.get(ex.concept_id) ?? 0;
                return (
                  <div
                    key={ex.id}
                    className="group mb-1 rounded-lg border border-zinc-100 p-2 text-sm dark:border-zinc-800"
                  >
                    <button
                      onClick={() => jumpToExcerpt(ex)}
                      className="block w-full text-left"
                      title={
                        ex.pos_start == null
                          ? "Pasted quote (no highlight)"
                          : "Jump to the highlight"
                      }
                    >
                      <span className="mb-1 flex items-center gap-1.5 text-xs text-zinc-500 dark:text-zinc-400">
                        <span
                          className="h-2.5 w-2.5 shrink-0 rounded-full"
                          style={{ backgroundColor: conceptColor(i).dot }}
                        />
                        <span className="truncate">
                          {conceptLabel.get(ex.concept_id) ?? "concept"}
                        </span>
                        <span className="ml-auto shrink-0">
                          {ex.page != null ? `p. ${ex.page} · ` : ""}
                          {authorName(ex.added_by)}
                        </span>
                      </span>
                      <span className="line-clamp-3 text-zinc-700 dark:text-zinc-300">
                        {cleanQuote(ex.quote)}
                      </span>
                    </button>
                    <button
                      onClick={() => deleteExcerpt(ex)}
                      className="mt-1 hidden text-xs text-zinc-500 underline underline-offset-2 hover:text-red-600 group-hover:block dark:text-zinc-400"
                    >
                      remove
                    </button>
                  </div>
                );
              })}
            </div>
          </aside>
        </div>
      )}

      {/* ---------------- Concept picker popover ---------------- */}
      {sel && (
        <>
          <div
            className="fixed inset-0 z-20"
            onClick={() => {
              setSel(null);
              setPickerQuery("");
            }}
          />
          <div
            className="fixed z-30 w-72 rounded-xl border border-zinc-200 bg-white p-2 shadow-lg dark:border-zinc-700 dark:bg-zinc-900"
            style={{
              left: Math.min(sel.x, window.innerWidth - 300),
              top: Math.min(sel.y + 10, window.innerHeight - 320),
            }}
          >
            <p className="mb-1 line-clamp-2 px-1 text-xs italic text-zinc-500 dark:text-zinc-400">
              &ldquo;
              {cleanQuote(sel.parts.map((p) => p.quote).join(" ")).slice(0, 140)}
              &rdquo;
              {sel.parts.length > 1 && (
                <span className="not-italic"> · spans {sel.parts.length} pages</span>
              )}
            </p>
            <input
              autoFocus
              value={pickerQuery}
              onChange={(e) => setPickerQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  setSel(null);
                  setPickerQuery("");
                }
                if (e.key === "Enter") {
                  e.preventDefault();
                  if (filteredConcepts.length > 0) {
                    saveSelection(filteredConcepts[0]);
                  } else if (pickerQuery.trim()) {
                    createConceptAndSave(pickerQuery);
                  }
                }
              }}
              placeholder="Find or create a concept..."
              className="mb-1 h-8 w-full rounded-lg border border-zinc-300 bg-white px-2 text-sm text-zinc-900 outline-none focus:border-teal-600 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50"
            />
            <div className="max-h-56 overflow-y-auto">
              {filteredConcepts.map((c) => {
                const i = conceptIndex.get(c.id) ?? 0;
                return (
                  <button
                    key={c.id}
                    onClick={() => saveSelection(c)}
                    disabled={saving}
                    className={railBtn}
                  >
                    <span
                      className="h-3 w-3 shrink-0 rounded-full"
                      style={{ backgroundColor: conceptColor(i).dot }}
                    />
                    <span className="min-w-0 flex-1 truncate text-zinc-800 dark:text-zinc-200">
                      {c.label}
                    </span>
                  </button>
                );
              })}
              {pickerQuery.trim() && !exactMatch && (
                <button
                  onClick={() => createConceptAndSave(pickerQuery)}
                  disabled={saving}
                  className={`${railBtn} font-medium text-teal-700 dark:text-teal-300`}
                >
                  + New concept &ldquo;{pickerQuery.trim().slice(0, 40)}&rdquo;
                </button>
              )}
            </div>
          </div>
        </>
      )}

      {notice && (
        <div className="pointer-events-none fixed bottom-6 left-1/2 z-40 -translate-x-1/2 rounded-full bg-zinc-900 px-4 py-2 text-sm text-zinc-50 dark:bg-zinc-50 dark:text-zinc-900">
          {notice}
        </div>
      )}
    </main>
  );
}
