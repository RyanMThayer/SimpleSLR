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
import {
  awaitingTeammates,
  decisionsByRecord,
  requiredFor,
  settledOutcome,
} from "@/lib/outcomes";
import AwaitingNote from "@/components/project/AwaitingNote";
import { fetchResolutions, resKey } from "@/lib/resolutions";
import { signedFulltextUrl } from "@/lib/fulltext";
import { buildAnchor, findAnchor, snapToWords } from "@/lib/anchors";
import { cleanQuote } from "@/lib/concepts";
import ApiKeyInfoModal from "@/components/project/ApiKeyInfoModal";
import { systemPrompt, vocabBlock } from "@/lib/aipass";
import {
  AI_MODELS,
  keyStoreFor,
  providerOf,
  type AiModelId,
} from "@/lib/aiModels";
import {
  estimateCost,
  formatCost,
  updateCalib,
  type Calib,
  type RunUsage,
} from "@/lib/costEstimate";
import type {
  Concept,
  ConceptExcerpt,
  ConceptSuggestion,
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

// AI pass models come from the shared lib (also used by the
// prescreen); the user's choice is kept per device.
const MODEL_STORE = "simpleslr-ai-model";

// Cost preview persistence: per-model chars-per-token ratio and
// average output length, learned from the billed usage of real runs
// (see src/lib/costEstimate.ts). Per browser, like the keys.
const CALIB_STORE = "simpleslr-cost-calib";
function readCalib(): Calib {
  try {
    const parsed: unknown = JSON.parse(
      localStorage.getItem(CALIB_STORE) ?? "{}"
    );
    return parsed && typeof parsed === "object" ? (parsed as Calib) : {};
  } catch {
    return {};
  }
}

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

type PlainRect = { top: number; left: number; width: number; height: number };

/**
 * Merge rect fragments that sit on the same text line into one rect
 * per line, so a highlight never paints the same spot twice (stacked
 * translucent rects read darker) and span seams disappear.
 */
function mergeLineRects(rects: PlainRect[]): PlainRect[] {
  const sorted = [...rects].sort((a, b) => a.top - b.top || a.left - b.left);
  const merged: PlainRect[] = [];
  for (const r of sorted) {
    const last = merged[merged.length - 1];
    const sameLine =
      last && Math.abs(last.top - r.top) < Math.min(last.height, r.height) * 0.6;
    const touches = last && r.left <= last.left + last.width + 3;
    if (last && sameLine && touches) {
      const right = Math.max(last.left + last.width, r.left + r.width);
      const bottom = Math.max(last.top + last.height, r.top + r.height);
      last.left = Math.min(last.left, r.left);
      last.top = Math.min(last.top, r.top);
      last.width = right - last.left;
      last.height = bottom - last.top;
    } else {
      merged.push({ ...r });
    }
  }
  return merged;
}

/**
 * Rects covering [start, end) of the text layer's text, computed per
 * TEXT NODE. Range.getClientRects() on a multi node range also returns
 * the border boxes of fully contained span elements, which stacks a
 * second translucent rect over interior lines; going node by node
 * avoids that entirely.
 */
function rectsForOffsets(
  root: HTMLElement,
  start: number,
  end: number,
  origin: DOMRect
): PlainRect[] {
  const out: PlainRect[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let total = 0;
  for (let cur = walker.nextNode(); cur; cur = walker.nextNode()) {
    const len = (cur as Text).data.length;
    const nodeStart = total;
    const nodeEnd = total + len;
    total = nodeEnd;
    if (nodeEnd <= start) continue;
    if (nodeStart >= end) break;
    const s = Math.max(start, nodeStart) - nodeStart;
    const e = Math.min(end, nodeEnd) - nodeStart;
    if (s >= e) continue;
    const r = document.createRange();
    try {
      r.setStart(cur, s);
      r.setEnd(cur, e);
    } catch {
      continue;
    }
    for (const cr of r.getClientRects()) {
      if (cr.width < 1 || cr.height < 1) continue;
      out.push({
        top: cr.top - origin.top,
        left: cr.left - origin.left,
        width: cr.width,
        height: cr.height,
      });
    }
  }
  return mergeLineRects(out);
}

type HighlightRect = {
  top: number;
  left: number;
  width: number;
  height: number;
  excerptId: string;
  fill: string;
  dot: string;
  title: string;
};

/** The hover chip naming a highlight's concept, anchored to one rect. */
type HoverTip = {
  top: number;
  left: number;
  height: number;
  text: string;
  dot: string;
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
  suggestions,
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
  suggestions: ConceptSuggestion[];
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
  const [sugRects, setSugRects] = useState<
    (PlainRect & { sugId: string; color: string; title: string })[]
  >([]);
  const [hoverTip, setHoverTip] = useState<HoverTip | null>(null);

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
      const idx = conceptIndex.get(ex.concept_id) ?? 0;
      const label = conceptLabel.get(ex.concept_id) ?? "concept";
      for (const r of rectsForOffsets(textDiv, hit.start, hit.end, wrapBox)) {
        out.push({
          ...r,
          excerptId: ex.id,
          fill: conceptColor(idx).fill,
          dot: conceptColor(idx).dot,
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
      out.push(
        ...rectsForOffsets(
          textDiv,
          pending.start,
          pending.end,
          wrap.getBoundingClientRect()
        )
      );
    }
    // Derived from DOM geometry after render, like the highlight rects.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPendingRects(out);
  }, [pending, pageText]);

  // Dashed overlays for pending AI suggestions on this page.
  useEffect(() => {
    const out: (PlainRect & { sugId: string; color: string; title: string })[] =
      [];
    const textDiv = textRef.current;
    const wrap = wrapRef.current;
    if (textDiv && wrap && pageText !== null && suggestions.length > 0) {
      const wrapBox = wrap.getBoundingClientRect();
      for (const sg of suggestions) {
        if (sg.pos_start == null || sg.pos_end == null) continue;
        const hit = findAnchor(pageText, {
          quote: sg.quote,
          pos_start: sg.pos_start,
          pos_end: sg.pos_end,
          prefix: sg.prefix ?? "",
          suffix: sg.suffix ?? "",
        });
        if (!hit) continue;
        const idx = sg.concept_id ? conceptIndex.get(sg.concept_id) : undefined;
        const color =
          idx !== undefined ? conceptColor(idx).dot : "hsl(275, 55%, 55%)";
        for (const r of rectsForOffsets(textDiv, hit.start, hit.end, wrapBox)) {
          out.push({
            ...r,
            sugId: sg.id,
            color,
            title: `Suggested: ${sg.concept_label} — accept or reject in the panel`,
          });
        }
      }
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSugRects(out);
  }, [pageText, suggestions, conceptIndex]);

  // The text layer sits above the highlight overlay and captures all
  // pointer events, so hover and click on highlights are resolved by
  // hit testing the rects at the page level. This also keeps text
  // selection working over highlighted passages.
  function hitAt(e: React.MouseEvent): { tip: HoverTip; excerptId?: string } | null {
    const wrap = wrapRef.current;
    if (!wrap) return null;
    const box = wrap.getBoundingClientRect();
    const x = e.clientX - box.left;
    const y = e.clientY - box.top;
    const inside = (r: PlainRect) =>
      x >= r.left && x <= r.left + r.width && y >= r.top && y <= r.top + r.height;
    for (const r of sugRects) {
      if (inside(r)) {
        return {
          tip: { top: r.top, left: r.left, height: r.height, text: r.title, dot: r.color },
        };
      }
    }
    for (const r of rects) {
      if (inside(r)) {
        return {
          tip: { top: r.top, left: r.left, height: r.height, text: r.title, dot: r.dot },
          excerptId: r.excerptId,
        };
      }
    }
    return null;
  }

  function handleHover(e: React.MouseEvent) {
    const hit = hitAt(e);
    setHoverTip((prev) => {
      const next = hit?.tip ?? null;
      if (
        prev === next ||
        (prev && next && prev.text === next.text && prev.top === next.top && prev.left === next.left)
      ) {
        return prev;
      }
      return next;
    });
  }

  function handleClick(e: React.MouseEvent) {
    const s = window.getSelection();
    if (s && !s.isCollapsed) return; // a selection, not a click on a highlight
    const hit = hitAt(e);
    if (hit?.excerptId) onPickExcerpt(hit.excerptId);
  }

  return (
    <div
      ref={(el) => {
        wrapRef.current = el;
        registerEl(pageNo, el);
      }}
      onMouseMove={handleHover}
      onMouseLeave={() => setHoverTip(null)}
      onClick={handleClick}
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
            className={`absolute rounded-[2px] ${
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
        {sugRects.map((r, i) => (
          <div
            key={`s${i}`}
            className={`absolute rounded-[2px] ${
              flashId === r.sugId ? "ring-2 ring-teal-600" : ""
            }`}
            style={{
              top: r.top,
              left: r.left,
              width: r.width,
              height: r.height,
              border: `1.5px dashed ${r.color}`,
            }}
          />
        ))}
        {hoverTip && (
          <div
            className={`pointer-events-none absolute z-20 flex max-w-72 items-center gap-1.5 rounded-md border border-zinc-200 bg-white px-2 py-1 text-xs font-medium text-zinc-800 shadow-md dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 ${
              hoverTip.top < 32 ? "" : "-translate-y-full"
            }`}
            style={{
              top: hoverTip.top < 32 ? hoverTip.top + hoverTip.height + 4 : hoverTip.top - 4,
              left: Math.max(0, Math.min(hoverTip.left, (size?.w ?? 600) - 240)),
            }}
          >
            <span
              className="h-2.5 w-2.5 shrink-0 rounded-full"
              style={{ backgroundColor: hoverTip.dot }}
            />
            <span className="truncate">{hoverTip.text}</span>
          </div>
        )}
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
  const [awaitingCount, setAwaitingCount] = useState(0);
  const [recIdx, setRecIdx] = useState(0);
  const [concepts, setConcepts] = useState<Concept[]>([]);
  const [tags, setTags] = useState<ConceptTag[]>([]);
  const [excerpts, setExcerpts] = useState<ConceptExcerpt[]>([]);
  const [names, setNames] = useState<Map<string, string>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // AI pass: quarantined suggestions plus the caller's own API key,
  // which lives only in this browser's localStorage.
  const [suggestions, setSuggestions] = useState<ConceptSuggestion[]>([]);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiMsg, setAiMsg] = useState<string | null>(null);
  const [aiErr, setAiErr] = useState(false);
  const [hasKey, setHasKey] = useState(false);
  // The "about your API key" panel, plus which providers currently have
  // a key in this browser (read fresh each time the panel opens).
  const [keyInfoOpen, setKeyInfoOpen] = useState(false);
  const [aiModel, setAiModel] = useState<AiModelId>("claude-sonnet-5");
  // Cost preview inputs: the open paper's measured character count
  // (null until counted, 0 for scans) and the learned calibration.
  const [docChars, setDocChars] = useState<number | null>(null);
  const [calib, setCalib] = useState<Calib>({});
  const [decidingSug, setDecidingSug] = useState<string | null>(null);
  const [editingConceptId, setEditingConceptId] = useState<string | null>(null);
  const [conceptDraft, setConceptDraft] = useState("");
  // Last deleted concept with its data, restorable while the toast shows.
  const [undoDel, setUndoDel] = useState<{
    concept: Concept;
    tags: ConceptTag[];
    excerpts: ConceptExcerpt[];
  } | null>(null);
  const undoTimer = useRef<number | null>(null);

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
      // Settled outcomes only: under independent screening a record
      // reaches the reading room once both stages hit their opinion
      // quota (or a resolution) and ended included.
      const resMap = await fetchResolutions(supabase, project.id);
      const taReq = requiredFor(project, "title_abstract");
      const ftReq = requiredFor(project, "full_text");
      const includedIds = [...taMap.entries()]
        .filter(
          ([id, ta]) =>
            settledOutcome(
              ta,
              resMap.get(resKey("title_abstract", id)),
              taReq
            ) === "included" &&
            settledOutcome(
              ftMap.get(id) ?? [],
              resMap.get(resKey("full_text", id)),
              ftReq
            ) === "included"
        )
        .map(([id]) => id);

      // Papers a reviewer already screened that still sit below their
      // opinion quota would otherwise vanish from this room without a
      // trace; count them so the UI can say they are waiting.
      const waitIds = awaitingTeammates({
        ta: taMap,
        ft: ftMap,
        resolutionFor: (stage, id) => resMap.get(resKey(stage, id)),
        taRequired: taReq,
        ftRequired: ftReq,
      });
      const allWait = [...waitIds.ta, ...waitIds.ft];
      let liveWait = 0;
      for (let i = 0; i < allWait.length; i += 100) {
        const { data } = await supabase
          .from("records")
          .select("id")
          .eq("project_id", project.id)
          .eq("status", "active")
          .in("id", allWait.slice(i, i + 100));
        liveWait += (data ?? []).length;
      }
      setAwaitingCount(liveWait);

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
      // Absent before migration 0016; an error here just means none.
      const { data: sugRows } = await supabase
        .from("concept_suggestions")
        .select("*")
        .eq("project_id", project.id)
        .order("created_at");
      setSuggestions((sugRows ?? []) as ConceptSuggestion[]);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [project]);

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
    setDocChars(null);
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
      // Count the paper's real characters for the cost preview. Runs
      // in pdf.js's worker after a beat so first-page rendering wins
      // the queue; the whole pass takes about half a second and never
      // touches the main thread or delays anything visible.
      (async () => {
        await new Promise((r) => setTimeout(r, 350));
        let chars = 0;
        for (let i = 1; i <= d.numPages; i++) {
          if (cancelled) return;
          const pg = await d.getPage(i);
          const tc = await pg.getTextContent();
          for (const it of tc.items) {
            if ("str" in it) chars += it.str.length;
          }
        }
        if (!cancelled) setDocChars(chars);
      })().catch(() => {
        // Preview only; the dropdown falls back to the page heuristic.
      });
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
  const paperSuggestions = useMemo(
    () =>
      suggestions
        .filter((s) => s.record_id === current?.id && s.status === "pending")
        .sort(
          (a, b) =>
            (a.page ?? 0) - (b.page ?? 0) ||
            (a.pos_start ?? 0) - (b.pos_start ?? 0)
        ),
    [suggestions, current?.id]
  );
  const sugsByPage = useMemo(() => {
    const m = new Map<number, ConceptSuggestion[]>();
    paperSuggestions.forEach((s) => {
      if (s.page == null || s.pos_start == null) return;
      const list = m.get(s.page) ?? [];
      list.push(s);
      m.set(s.page, list);
    });
    return m;
  }, [paperSuggestions]);

  // Predicted input size of one AI pass over the open paper: measured
  // characters once counted (page heuristic until then; 0 means a scan
  // with nothing to send), plus prompt overhead measured from the same
  // strings the server sends (page labels approximated).
  const estInputChars = useMemo(() => {
    if (numPages === 0) return null;
    if (docChars === 0) return 0;
    const paper = docChars ?? numPages * 3000;
    const overhead =
      systemPrompt(project.research_question, project.inclusion_criteria)
        .length +
      vocabBlock(concepts).length +
      (current?.title?.length ?? 60) +
      numPages * 12 +
      40;
    return paper + overhead;
  }, [
    docChars,
    numPages,
    concepts,
    project.research_question,
    project.inclusion_criteria,
    current?.title,
  ]);

  // Restore the model choice, and check for the matching provider key
  // whenever the choice changes.
  useEffect(() => {
    try {
      const stored = localStorage.getItem(MODEL_STORE);
      if (stored && AI_MODELS.some((m) => m.id === stored)) {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setAiModel(stored as AiModelId);
      }
      setCalib(readCalib());
    } catch {
      // Storage unavailable: default model stands.
    }
  }, []);
  useEffect(() => {
    try {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setHasKey(Boolean(localStorage.getItem(keyStoreFor(providerOf(aiModel)))));
    } catch {
      // Storage unavailable: the key form stays visible.
    }
  }, [aiModel]);

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

  /**
   * Scroll so the quote itself sits centered in the viewport, not just
   * its page: the anchor resolves to the same rects the highlight
   * paints, and the scroll container is moved to their midpoint. Falls
   * back to centering the page when the anchor cannot resolve.
   */
  function anchorScroll(
    page: number,
    ex: {
      quote: string;
      pos_start: number | null;
      pos_end: number | null;
      prefix: string | null;
      suffix: string | null;
    }
  ) {
    const wrap = pageEls.current.get(page);
    const viewport = viewportRef.current;
    const fallback = () =>
      wrap?.scrollIntoView({ behavior: "smooth", block: "center" });
    if (!wrap || !viewport) {
      fallback();
      return;
    }
    const textDiv = wrap.querySelector(".textLayer") as HTMLElement | null;
    const pageText = pageTexts.current.get(page);
    if (
      !textDiv ||
      pageText == null ||
      ex.pos_start == null ||
      ex.pos_end == null
    ) {
      fallback();
      return;
    }
    const hit = findAnchor(pageText, {
      quote: ex.quote,
      pos_start: ex.pos_start,
      pos_end: ex.pos_end,
      prefix: ex.prefix ?? "",
      suffix: ex.suffix ?? "",
    });
    if (!hit) {
      fallback();
      return;
    }
    const rects = rectsForOffsets(
      textDiv,
      hit.start,
      hit.end,
      wrap.getBoundingClientRect()
    );
    if (rects.length === 0) {
      fallback();
      return;
    }
    const top = Math.min(...rects.map((r) => r.top));
    const bottom = Math.max(...rects.map((r) => r.top + r.height));
    const wrapTop =
      wrap.getBoundingClientRect().top -
      viewport.getBoundingClientRect().top +
      viewport.scrollTop;
    const target = wrapTop + (top + bottom) / 2 - viewport.clientHeight / 2;
    viewport.scrollTo({ top: Math.max(0, target), behavior: "smooth" });
  }

  function jumpToExcerpt(ex: ConceptExcerpt) {
    if (ex.page != null) anchorScroll(ex.page, ex);
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
  // The paper's cell in the matrix: toggle the checkmark directly, and
  // manage the concept list (rename, delete) without leaving the room.
  // ------------------------------------------------------------------
  async function toggleTag(c: Concept) {
    if (!current) return;
    const n = countByConcept.get(c.id) ?? 0;
    const checked = taggedConcepts.has(c.id) || n > 0;
    const supabase = createClient();
    if (!checked) {
      const { data, error: tErr } = await supabase
        .from("concept_tags")
        .insert({
          project_id: project.id,
          concept_id: c.id,
          record_id: current.id,
          tagged_by: userId,
        })
        .select("*")
        .single();
      if (tErr || !data) {
        setError(tErr?.message ?? "Could not add the checkmark.");
        return;
      }
      setTags((ts) => [...ts, data as ConceptTag]);
      return;
    }
    if (
      n > 0 &&
      !window.confirm(
        `Uncheck "${c.label}" for this paper? Its ${n} excerpt(s) here are removed too.`
      )
    ) {
      return;
    }
    if (n > 0) {
      const { error: exErr } = await supabase
        .from("concept_excerpts")
        .delete()
        .eq("record_id", current.id)
        .eq("concept_id", c.id);
      if (exErr) {
        setError(exErr.message);
        return;
      }
    }
    const { error: tErr } = await supabase
      .from("concept_tags")
      .delete()
      .eq("record_id", current.id)
      .eq("concept_id", c.id);
    if (tErr) {
      setError(tErr.message);
      return;
    }
    setExcerpts((xs) =>
      xs.filter(
        (x) => !(x.record_id === current.id && x.concept_id === c.id)
      )
    );
    setTags((ts) =>
      ts.filter(
        (t) => !(t.record_id === current.id && t.concept_id === c.id)
      )
    );
  }

  async function saveConceptRename() {
    const label = conceptDraft.trim();
    if (!label || !editingConceptId) {
      setEditingConceptId(null);
      return;
    }
    const supabase = createClient();
    const { error: upErr } = await supabase
      .from("concepts")
      .update({ label })
      .eq("id", editingConceptId);
    if (upErr) {
      setError(upErr.message);
      return;
    }
    setConcepts((cs) =>
      cs.map((c) => (c.id === editingConceptId ? { ...c, label } : c))
    );
    setSuggestions((ss) =>
      ss.map((s) =>
        s.concept_id === editingConceptId ? { ...s, concept_label: label } : s
      )
    );
    setEditingConceptId(null);
  }

  async function deleteConcept(c: Concept) {
    // No confirmation dialog: cleanup sessions delete many concepts in
    // a row. Instead the concept and its data are snapshotted and the
    // toast offers Undo for a few seconds.
    const snapshot = {
      concept: c,
      tags: tags.filter((t) => t.concept_id === c.id),
      excerpts: excerpts.filter((e) => e.concept_id === c.id),
    };
    const supabase = createClient();
    const { error: delErr } = await supabase
      .from("concepts")
      .delete()
      .eq("id", c.id);
    if (delErr) {
      setError(delErr.message);
      return;
    }
    setConcepts((cs) => cs.filter((x) => x.id !== c.id));
    setTags((ts) => ts.filter((t) => t.concept_id !== c.id));
    setExcerpts((xs) => xs.filter((x) => x.concept_id !== c.id));
    setSuggestions((ss) => ss.filter((s) => s.concept_id !== c.id));
    setUndoDel(snapshot);
    if (undoTimer.current) window.clearTimeout(undoTimer.current);
    undoTimer.current = window.setTimeout(() => setUndoDel(null), 8000);
  }

  async function undoDeleteConcept() {
    if (!undoDel) return;
    const { concept, tags: oldTags, excerpts: oldExcerpts } = undoDel;
    setUndoDel(null);
    if (undoTimer.current) window.clearTimeout(undoTimer.current);
    const supabase = createClient();
    const { data: reborn, error: cErr } = await supabase
      .from("concepts")
      .insert({
        project_id: project.id,
        label: concept.label,
        description: concept.description,
        position: concept.position,
        created_by: concept.created_by,
      })
      .select("*")
      .single();
    if (cErr || !reborn) {
      setError(cErr?.message ?? "Could not restore the concept.");
      return;
    }
    const newId = (reborn as Concept).id;
    let newTags: ConceptTag[] = [];
    if (oldTags.length > 0) {
      const { data } = await supabase
        .from("concept_tags")
        .insert(
          oldTags.map((t) => ({
            project_id: project.id,
            concept_id: newId,
            record_id: t.record_id,
            unit: t.unit,
            note: t.note,
            tagged_by: t.tagged_by,
          }))
        )
        .select("*");
      newTags = (data ?? []) as ConceptTag[];
    }
    let newExcerpts: ConceptExcerpt[] = [];
    if (oldExcerpts.length > 0) {
      const { data } = await supabase
        .from("concept_excerpts")
        .insert(
          oldExcerpts.map((e) => ({
            project_id: project.id,
            concept_id: newId,
            record_id: e.record_id,
            quote: e.quote,
            page: e.page,
            pos_start: e.pos_start,
            pos_end: e.pos_end,
            prefix: e.prefix,
            suffix: e.suffix,
            added_by: e.added_by,
          }))
        )
        .select("*");
      newExcerpts = (data ?? []) as ConceptExcerpt[];
    }
    setConcepts((cs) => [...cs, reborn as Concept]);
    setTags((ts) => [...ts, ...newTags]);
    setExcerpts((xs) => [...xs, ...newExcerpts]);
  }

  // ------------------------------------------------------------------
  // AI pass
  // ------------------------------------------------------------------
  function chooseModel(id: AiModelId) {
    setAiModel(id);
    try {
      localStorage.setItem(MODEL_STORE, id);
    } catch {
      // Not persisted; still used for this session.
    }
  }

  function openKeyInfo() {
    setKeyInfoOpen(true);
  }

  async function runAiPass() {
    if (!current?.fulltext_path || aiBusy) return;
    let key = "";
    try {
      key = localStorage.getItem(keyStoreFor(providerOf(aiModel))) ?? "";
    } catch {
      /* handled below */
    }
    if (!key) {
      setHasKey(false);
      setAiErr(true);
      setAiMsg("No API key for this model's provider; add one under Project settings.");
      return;
    }
    setAiBusy(true);
    setAiErr(false);
    setAiMsg("Reading the paper and looking for concept evidence...");
    try {
      const res = await fetch("/api/aipass", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: project.id,
          recordId: current.id,
          apiKey: key,
          model: aiModel,
        }),
      });
      const data = await res.json().catch(() => null);
      if (!data || data.error) {
        setAiErr(true);
        setAiMsg(
          data?.error ??
            `The server responded ${res.status}${res.status === 504 ? " (timed out; try again, the extracted text is now cached)" : ""}.`
        );
      } else {
        const bits = [`${data.suggested} suggestion(s) to review`];
        if (data.suggested > 0 && typeof data.matchedConcepts === "number") {
          bits.push(
            `${data.matchedConcepts} existing concept(s) matched, ${data.newConcepts} new proposed`
          );
        }
        if (data.droppedUnverified > 0) {
          bits.push(`${data.droppedUnverified} dropped as unverifiable`);
        }
        if (data.droppedDuplicate > 0) {
          bits.push(`${data.droppedDuplicate} already covered`);
        }
        if (data.droppedBadLabel > 0) {
          bits.push(`${data.droppedBadLabel} dropped for unusable labels`);
        }
        if (data.truncated) bits.push("long paper truncated");
        setAiErr(false);
        setAiMsg(bits.join(" · ") + ".");
        // Fold the provider's billed usage into this model's cost
        // calibration, so future previews use the real ratio.
        const u = data.usage as RunUsage | null | undefined;
        if (
          u &&
          typeof u.inputChars === "number" &&
          typeof u.inputTokens === "number" &&
          typeof u.outputTokens === "number"
        ) {
          setCalib((prev) => {
            const next = updateCalib(prev, aiModel, u);
            try {
              localStorage.setItem(CALIB_STORE, JSON.stringify(next));
            } catch {
              // Preview-only state; losing it costs nothing.
            }
            return next;
          });
        }
        const supabase = createClient();
        const { data: sugRows } = await supabase
          .from("concept_suggestions")
          .select("*")
          .eq("project_id", project.id)
          .order("created_at");
        setSuggestions((sugRows ?? []) as ConceptSuggestion[]);
      }
    } catch (e) {
      setAiErr(true);
      setAiMsg(e instanceof Error ? e.message : String(e));
    }
    setAiBusy(false);
  }

  async function acceptSuggestion(sug: ConceptSuggestion) {
    if (!current || decidingSug) return;
    setDecidingSug(sug.id);
    const supabase = createClient();
    try {
      // Resolve or create the concept (a proposed label may match a
      // concept created since the run).
      let conceptId = sug.concept_id;
      if (!conceptId) {
        const match = concepts.find(
          (c) =>
            c.label.trim().toLowerCase() ===
            sug.concept_label.trim().toLowerCase()
        );
        conceptId = match?.id ?? null;
      }
      if (!conceptId) {
        const { data, error: cErr } = await supabase
          .from("concepts")
          .insert({
            project_id: project.id,
            label: sug.concept_label,
            description: sug.definition,
            position: concepts.length,
            created_by: userId,
          })
          .select("*")
          .single();
        if (cErr || !data) throw new Error(cErr?.message ?? "concept failed");
        setConcepts((cs) => [...cs, data as Concept]);
        conceptId = (data as Concept).id;
      }
      const { data: ex, error: exErr } = await supabase
        .from("concept_excerpts")
        .insert({
          project_id: project.id,
          concept_id: conceptId,
          record_id: current.id,
          quote: sug.quote,
          page: sug.page,
          pos_start: sug.pos_start,
          pos_end: sug.pos_end,
          prefix: sug.prefix,
          suffix: sug.suffix,
          added_by: userId,
        })
        .select("*")
        .single();
      if (exErr || !ex) throw new Error(exErr?.message ?? "excerpt failed");
      await supabase.from("concept_tags").upsert(
        {
          project_id: project.id,
          concept_id: conceptId,
          record_id: current.id,
          tagged_by: userId,
        },
        { onConflict: "concept_id,record_id", ignoreDuplicates: true }
      );
      const { error: upErr } = await supabase
        .from("concept_suggestions")
        .update({
          status: "accepted",
          concept_id: conceptId,
          decided_by: userId,
          decided_at: new Date().toISOString(),
          accepted_excerpt_id: (ex as ConceptExcerpt).id,
        })
        .eq("id", sug.id);
      if (upErr) throw new Error(upErr.message);
      setExcerpts((xs) => [...xs, ex as ConceptExcerpt]);
      setTags((ts) =>
        ts.some(
          (t) => t.concept_id === conceptId && t.record_id === current.id
        )
          ? ts
          : [
              ...ts,
              {
                id: `local-${sug.id}`,
                project_id: project.id,
                concept_id: conceptId,
                record_id: current.id,
                unit: null,
                note: null,
                tagged_by: userId,
                created_at: new Date().toISOString(),
              },
            ]
      );
      setSuggestions((ss) =>
        ss.map((s) =>
          s.id === sug.id
            ? { ...s, status: "accepted" as const, concept_id: conceptId }
            : s
        )
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    setDecidingSug(null);
  }

  async function rejectSuggestion(sug: ConceptSuggestion) {
    if (decidingSug) return;
    setDecidingSug(sug.id);
    const supabase = createClient();
    const { error: upErr } = await supabase
      .from("concept_suggestions")
      .update({
        status: "rejected",
        decided_by: userId,
        decided_at: new Date().toISOString(),
      })
      .eq("id", sug.id);
    if (upErr) setError(upErr.message);
    else {
      setSuggestions((ss) =>
        ss.map((s) =>
          s.id === sug.id ? { ...s, status: "rejected" as const } : s
        )
      );
    }
    setDecidingSug(null);
  }

  function jumpToSuggestion(sug: ConceptSuggestion) {
    if (sug.page != null) anchorScroll(sug.page, sug);
    setFlashId(sug.id);
    window.setTimeout(() => setFlashId((f) => (f === sug.id ? null : f)), 2000);
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
          <AwaitingNote count={awaitingCount} className="mt-2" />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-2">
          <AwaitingNote count={awaitingCount} />
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
                  suggestions={sugsByPage.get(n) ?? []}
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

            {/* ---------------- AI pass ---------------- */}
            <div className="rounded-xl border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900">
              <div className="mb-1 flex items-center justify-between">
                <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                  AI pass
                </p>
                <div className="flex items-center gap-1.5">
                  {paperSuggestions.length > 0 && (
                    <span className="rounded-full bg-violet-100 px-2 py-0.5 text-xs font-medium text-violet-700 dark:bg-violet-950 dark:text-violet-300">
                      {paperSuggestions.length} to review
                    </span>
                  )}
                  <button
                    onClick={openKeyInfo}
                    title="How your API key is used, how to get one, and how to keep it safe"
                    aria-label="About your API key"
                    className="flex h-5 w-5 items-center justify-center rounded-full border border-zinc-300 text-[11px] font-semibold text-zinc-500 transition-colors hover:border-teal-600 hover:text-teal-700 dark:border-zinc-600 dark:text-zinc-400 dark:hover:border-teal-400 dark:hover:text-teal-300"
                  >
                    ?
                  </button>
                </div>
              </div>
              <select
                value={aiModel}
                onChange={(e) => chooseModel(e.target.value as AiModelId)}
                className="mb-1.5 h-8 w-full rounded-lg border border-zinc-300 bg-white px-2 text-sm text-zinc-900 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50"
                title={(() => {
                  const base =
                    "Which model reads the paper; the matching provider's API key is used.";
                  const sel = AI_MODELS.find((m) => m.id === aiModel);
                  if (!sel || !estInputChars) return base;
                  const est = estimateCost(sel, estInputChars, calib);
                  return `${base} This paper: ${formatCost(est.typical)} expected, ${formatCost(est.max)} at most (response length is capped). Estimates sharpen after each real run.`;
                })()}
              >
                {AI_MODELS.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                    {estInputChars
                      ? ` · ${formatCost(estimateCost(m, estInputChars, calib).typical)}`
                      : ""}
                  </option>
                ))}
              </select>
              {!hasKey ? (
                <p className="text-xs text-zinc-600 dark:text-zinc-400">
                  No{" "}
                  {providerOf(aiModel) === "anthropic"
                    ? "Anthropic"
                    : "OpenAI"}{" "}
                  API key in this browser yet. Add one under{" "}
                  <Link
                    href={`/projects/${project.id}/settings`}
                    className="underline underline-offset-2 hover:text-teal-700 dark:hover:text-teal-300"
                  >
                    Project settings
                  </Link>
                  .{" "}
                  <button
                    type="button"
                    onClick={openKeyInfo}
                    className="underline underline-offset-2 hover:text-teal-700 dark:hover:text-teal-300"
                  >
                    How your key is handled, and how to get one
                  </button>
                </p>
              ) : (
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    onClick={runAiPass}
                    disabled={aiBusy || !current?.fulltext_path}
                    title="Reads this one paper only and suggests concept passages; every suggestion is verified verbatim against the PDF text and waits for your accept or reject."
                    className="rounded-full bg-teal-700 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-teal-800 disabled:opacity-50 dark:bg-teal-400 dark:text-teal-950 dark:hover:bg-teal-300"
                  >
                    {aiBusy ? "Reading..." : "Suggest concepts for this paper"}
                  </button>
                  <Link
                    href={`/projects/${project.id}/settings`}
                    className="text-xs text-zinc-500 underline underline-offset-2 dark:text-zinc-400"
                  >
                    manage keys
                  </Link>
                </div>
              )}
              {!current?.fulltext_path && (
                <p className="mt-1.5 text-xs text-amber-700 dark:text-amber-300">
                  This paper has no PDF attached, so there is nothing for the
                  AI to read — attach one in the records table first.
                </p>
              )}
              {aiMsg &&
                (aiErr ? (
                  <p className="mt-1.5 rounded-lg border border-red-300 bg-red-50 px-2.5 py-1.5 text-xs text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
                    {aiMsg}
                  </p>
                ) : (
                  <p className="mt-1.5 text-xs text-zinc-600 dark:text-zinc-400">
                    {aiMsg}
                  </p>
                ))}
              {paperSuggestions.length > 0 && (
                <div className="mt-2 flex max-h-72 flex-col gap-1 overflow-y-auto">
                  {paperSuggestions.map((sg) => {
                    const idx = sg.concept_id
                      ? conceptIndex.get(sg.concept_id)
                      : undefined;
                    return (
                      <div
                        key={sg.id}
                        className="rounded-lg border border-dashed border-zinc-300 p-2 text-sm dark:border-zinc-700"
                      >
                        <button
                          onClick={() => jumpToSuggestion(sg)}
                          className="block w-full text-left"
                          title={sg.note ?? undefined}
                        >
                          <span className="mb-1 flex items-center gap-1.5 text-xs text-zinc-500 dark:text-zinc-400">
                            <span
                              className="h-2.5 w-2.5 shrink-0 rounded-full"
                              style={{
                                backgroundColor:
                                  idx !== undefined
                                    ? conceptColor(idx).dot
                                    : "hsl(275, 55%, 55%)",
                              }}
                            />
                            <span className="truncate font-medium text-zinc-700 dark:text-zinc-300">
                              {sg.concept_label}
                            </span>
                            {!sg.concept_id && (
                              <span className="shrink-0 rounded-full bg-violet-100 px-1.5 text-[10px] font-medium text-violet-700 dark:bg-violet-950 dark:text-violet-300">
                                new
                              </span>
                            )}
                            <span className="ml-auto shrink-0">
                              p. {sg.page}
                            </span>
                          </span>
                          <span className="line-clamp-2 text-zinc-700 dark:text-zinc-300">
                            {cleanQuote(sg.quote)}
                          </span>
                        </button>
                        <div className="mt-1.5 flex gap-2">
                          <button
                            onClick={() => acceptSuggestion(sg)}
                            disabled={decidingSug !== null}
                            className="rounded-full bg-emerald-700 px-2.5 py-0.5 text-xs font-medium text-white disabled:opacity-50"
                          >
                            Accept
                          </button>
                          <button
                            onClick={() => rejectSuggestion(sg)}
                            disabled={decidingSug !== null}
                            className="rounded-full border border-zinc-300 px-2.5 py-0.5 text-xs text-zinc-700 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300"
                          >
                            Reject
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* ---------------- About your API key ---------------- */}
            <ApiKeyInfoModal
              open={keyInfoOpen}
              onClose={() => setKeyInfoOpen(false)}
              onKeysChanged={() => {
                try {
                  setHasKey(
                    Boolean(
                      localStorage.getItem(keyStoreFor(providerOf(aiModel)))
                    )
                  );
                } catch {
                  setHasKey(false);
                }
              }}
            />
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
                const checked = taggedConcepts.has(c.id) || n > 0;
                return (
                  <div
                    key={c.id}
                    className="group flex items-center gap-2 rounded-lg px-1 py-1 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                  >
                    <button
                      onClick={() => toggleTag(c)}
                      title={
                        checked
                          ? "Uncheck: this paper does not evidence the concept"
                          : "Check: this paper evidences the concept (even without a highlight)"
                      }
                      className={`flex h-5 w-5 shrink-0 items-center justify-center rounded border text-xs transition-colors ${
                        checked
                          ? "border-teal-700 bg-teal-700 text-white dark:border-teal-400 dark:bg-teal-400 dark:text-teal-950"
                          : "border-zinc-300 text-transparent hover:border-teal-600 dark:border-zinc-600"
                      }`}
                    >
                      ✓
                    </button>
                    <span
                      className="h-3 w-3 shrink-0 rounded-full"
                      style={{ backgroundColor: conceptColor(i).dot }}
                    />
                    {editingConceptId === c.id ? (
                      <form
                        onSubmit={(e) => {
                          e.preventDefault();
                          saveConceptRename();
                        }}
                        className="min-w-0 flex-1"
                      >
                        <input
                          autoFocus
                          value={conceptDraft}
                          onChange={(e) => setConceptDraft(e.target.value)}
                          onBlur={saveConceptRename}
                          onKeyDown={(e) => {
                            if (e.key === "Escape") setEditingConceptId(null);
                          }}
                          className="h-6 w-full rounded border border-teal-600 bg-white px-1 text-sm text-zinc-900 outline-none dark:bg-zinc-950 dark:text-zinc-50"
                        />
                      </form>
                    ) : (
                      <button
                        onClick={() => jumpToConcept(c.id)}
                        title={n > 0 ? "Jump to the first highlight" : undefined}
                        className={`min-w-0 flex-1 truncate text-left text-sm ${
                          checked
                            ? "text-zinc-900 dark:text-zinc-50"
                            : "text-zinc-500 dark:text-zinc-500"
                        }`}
                      >
                        {c.label}
                      </button>
                    )}
                    <span className="text-xs tabular-nums text-zinc-500 dark:text-zinc-400">
                      {n > 0 ? n : ""}
                    </span>
                    <span className="hidden shrink-0 gap-0.5 group-hover:flex">
                      <button
                        onClick={() => {
                          setEditingConceptId(c.id);
                          setConceptDraft(c.label);
                        }}
                        title="Rename this concept (everywhere)"
                        className="flex h-6 w-6 items-center justify-center rounded-md text-sm text-zinc-600 hover:bg-zinc-200 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-700 dark:hover:text-zinc-100"
                      >
                        ✎
                      </button>
                      <button
                        onClick={() => deleteConcept(c)}
                        title="Delete this concept from the whole project (undoable for a few seconds)"
                        className="flex h-6 w-6 items-center justify-center rounded-md text-base leading-none text-zinc-600 hover:bg-red-100 hover:text-red-700 dark:text-zinc-400 dark:hover:bg-red-950 dark:hover:text-red-300"
                      >
                        ×
                      </button>
                    </span>
                  </div>
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
      {undoDel && (
        <div className="fixed bottom-16 left-1/2 z-40 flex -translate-x-1/2 items-center gap-3 rounded-full bg-zinc-900 px-4 py-2 text-sm text-zinc-50 dark:bg-zinc-50 dark:text-zinc-900">
          <span>Deleted &ldquo;{undoDel.concept.label}&rdquo;</span>
          <button
            onClick={undoDeleteConcept}
            className="font-semibold underline underline-offset-2"
          >
            Undo
          </button>
        </div>
      )}
    </main>
  );
}
