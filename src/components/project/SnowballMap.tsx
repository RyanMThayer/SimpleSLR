"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import Link from "next/link";
import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
} from "d3-force";
import { createClient } from "@/lib/supabase/client";
import { requiredFor } from "@/lib/outcomes";
import { fetchResolutions, resKey } from "@/lib/resolutions";
import {
  buildSnowballGraph,
  mapStatus,
  nodeRadius,
  type BatchLite,
  type MapStatus,
  type RecordLite,
  type SnowballEdge,
  type SnowballNode,
  type SourceKind,
} from "@/lib/snowballGraph";
import type { Project, Stage } from "@/lib/types";

/**
 * The citation map: every snowball round drawn as one consolidated
 * graph. Seeds anchor the layout; candidates cluster around whichever
 * seeds produced them, and a paper surfaced by several seeds sits
 * between them with an edge to each. Color = screening status (the
 * settled, blind-safe outcome), shape = how the record entered
 * (OpenAlex, a database export file, or manual entry), size = how many
 * seeds corroborate it, ring = seed. Backward edges are solid (the
 * seed cites it), forward edges are dashed (it cites the seed).
 *
 * Palette validated for light and dark surfaces and color vision
 * deficiency (conflict is drawn as a split emerald/red node rather
 * than a third red-adjacent hue); status is never color alone: the
 * legend, tooltips, and the detail panel restate it in words, and the
 * records table remains the tabular fallback.
 */

const W = 1200;
const H = 760;

const PALETTE = {
  light: {
    included: "#059669",
    excluded: "#dc2626",
    prescreened: "#8b5cf6",
    screening: "#a1a1aa",
    ink: "#18181b",
    edge: "#a1a1aa",
    label: "#3f3f46",
    surfaceRing: "#ffffff",
  },
  dark: {
    included: "#059669",
    excluded: "#ef4444",
    prescreened: "#8b5cf6",
    screening: "#71717a",
    ink: "#fafafa",
    edge: "#52525b",
    label: "#a1a1aa",
    surfaceRing: "#18181b",
  },
};

const STATUS_LABEL: Record<MapStatus, string> = {
  included: "included",
  excluded: "excluded",
  conflict: "conflict",
  screening: "in screening",
  prescreened: "AI prescreened",
};

const SOURCE_LABEL: Record<SourceKind, string> = {
  openalex: "OpenAlex",
  file: "database export file",
  manual: "manual entry",
  screening: "screening corpus",
};

function useIsDark(): boolean {
  const [dark, setDark] = useState(false);
  useEffect(() => {
    const el = document.documentElement;
    const read = () => setDark(el.classList.contains("dark"));
    read();
    const mo = new MutationObserver(read);
    mo.observe(el, { attributes: true, attributeFilter: ["class"] });
    return () => mo.disconnect();
  }, []);
  return dark;
}

type Loaded = {
  nodes: SnowballNode[];
  edges: SnowballEdge[];
};

export default function SnowballMap({ project }: { project: Project }) {
  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  // View transform (pan/zoom) and layout mode.
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const [layout, setLayout] = useState<"network" | "timeline">("network");
  // Filters: direction toggles and status toggles (all on by default).
  const [showBackward, setShowBackward] = useState(true);
  const [showForward, setShowForward] = useState(true);
  const [statusOn, setStatusOn] = useState<Record<MapStatus, boolean>>({
    included: true,
    excluded: true,
    conflict: true,
    screening: true,
    prescreened: true,
  });
  const [search, setSearch] = useState("");
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [hoverPos, setHoverPos] = useState<{ x: number; y: number } | null>(
    null
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [frame, setFrame] = useState(0);
  const isDark = useIsDark();
  const pal = isDark ? PALETTE.dark : PALETTE.light;

  // Whether a node drag is in flight, mirrored into state only where
  // render output depends on it (the tooltip suppression).
  const [draggingNode, setDraggingNode] = useState(false);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const simRef = useRef<ReturnType<
    typeof forceSimulation<SnowballNode, SnowballEdge>
  > | null>(null);
  const dragRef = useRef<{
    id: string | null;
    panning: boolean;
    lastX: number;
    lastY: number;
    moved: boolean;
  }>({ id: null, panning: false, lastX: 0, lastY: 0, moved: false });

  // ------------------------------------------------------------------
  // Data
  // ------------------------------------------------------------------
  const load = useCallback(async () => {
    const supabase = createClient();
    try {
      const paged = async <T,>(
        build: (from: number, to: number) => PromiseLike<{
          data: T[] | null;
          error: { message: string } | null;
        }>
      ): Promise<T[]> => {
        const out: T[] = [];
        for (let from = 0; ; from += 1000) {
          const { data: rows, error: err } = await build(from, from + 999);
          if (err) throw new Error(err.message);
          out.push(...(rows ?? []));
          if (!rows || rows.length < 1000) break;
        }
        return out;
      };

      const links = await paged<{
        record_id: string;
        seed_record_id: string;
        direction: string;
      }>((f, t) =>
        supabase
          .from("snowball_links")
          .select("record_id, seed_record_id, direction")
          .eq("project_id", project.id)
          .range(f, t)
      );
      if (links.length === 0) {
        setData({ nodes: [], edges: [] });
        return;
      }

      const ids = [
        ...new Set(links.flatMap((l) => [l.record_id, l.seed_record_id])),
      ];
      const records = new Map<string, RecordLite>();
      for (let i = 0; i < ids.length; i += 100) {
        const { data: recs, error: rErr } = await supabase
          .from("records")
          .select("id, title, authors, year, status, batch_id")
          .in("id", ids.slice(i, i + 100));
        if (rErr) throw new Error(rErr.message);
        (recs ?? []).forEach((r) => records.set(r.id, r as RecordLite));
      }

      const batchRows = await paged<BatchLite>((f, t) =>
        supabase
          .from("import_batches")
          .select("id, filename, origin")
          .eq("project_id", project.id)
          .range(f, t)
      );
      const batches = new Map(batchRows.map((b) => [b.id, b]));

      const decRows = await paged<{
        record_id: string;
        stage: string;
        decision: string;
      }>((f, t) =>
        supabase
          .from("screening_decisions")
          .select("record_id, stage, decision")
          .eq("project_id", project.id)
          .range(f, t)
      );
      const ta = new Map<string, { decision: string }[]>();
      const ft = new Map<string, { decision: string }[]>();
      decRows.forEach((d) => {
        const m = d.stage === "full_text" ? ft : ta;
        const list = m.get(d.record_id) ?? [];
        list.push(d);
        m.set(d.record_id, list);
      });
      const resMap = await fetchResolutions(supabase, project.id);
      const req = (stage: Stage) => requiredFor(project, stage);

      const graph = buildSnowballGraph({
        links,
        records,
        batches,
        statusOf: (rec) =>
          mapStatus(
            rec.status,
            ta.get(rec.id) ?? [],
            ft.get(rec.id) ?? [],
            resMap.get(resKey("title_abstract", rec.id)),
            resMap.get(resKey("full_text", rec.id)),
            req
          ),
      });
      setData(graph);
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
  // Layout: seeds on a ring, candidates near their seeds, then a
  // synchronously settled force simulation (no layout jitter on open).
  // ------------------------------------------------------------------
  const yearScale = useMemo(() => {
    const years = (data?.nodes ?? [])
      .map((n) => n.year)
      .filter((y): y is number => y !== null && y > 1800);
    if (years.length < 2) return null;
    const min = Math.min(...years);
    const max = Math.max(...years);
    if (min === max) return null;
    return {
      min,
      max,
      x: (y: number) => 90 + ((y - min) / (max - min)) * (W - 220),
    };
  }, [data]);

  useEffect(() => {
    if (!data || data.nodes.length === 0) return;
    const nodes = data.nodes;
    const seeds = nodes.filter((n) => n.isSeed);
    const bySeed = new Map<string, SnowballNode>(
      seeds.map((s) => [s.id, s])
    );
    seeds.forEach((s, i) => {
      const a = (i / Math.max(1, seeds.length)) * 2 * Math.PI;
      const r = seeds.length > 1 ? Math.min(W, H) / 4 : 0;
      s.x = W / 2 + r * Math.cos(a);
      s.y = H / 2 + r * Math.sin(a);
    });
    // Candidates start beside one of their seeds, spread on a small ring.
    const firstSeedOf = new Map<string, string>();
    data.edges.forEach((e) => {
      if (!firstSeedOf.has(e.recordId)) firstSeedOf.set(e.recordId, e.seedId);
    });
    nodes
      .filter((n) => !n.isSeed)
      .forEach((n, i) => {
        const seed = bySeed.get(firstSeedOf.get(n.id) ?? "");
        const a = (i * 2.399963) % (2 * Math.PI); // golden angle spread
        n.x = (seed?.x ?? W / 2) + 90 * Math.cos(a);
        n.y = (seed?.y ?? H / 2) + 90 * Math.sin(a);
      });

    simRef.current?.stop();
    const sim = forceSimulation<SnowballNode, SnowballEdge>(nodes)
      .force(
        "link",
        forceLink<SnowballNode, SnowballEdge>(data.edges)
          .id((d) => d.id)
          .distance((e) => (e.direction === "backward" ? 85 : 115))
          .strength(0.5)
      )
      .force(
        "charge",
        forceManyBody<SnowballNode>().strength((d) =>
          d.isSeed ? -420 : -70
        )
      )
      .force(
        "collide",
        forceCollide<SnowballNode>((d) => nodeRadius(d) + 6)
      )
      .force(
        "x",
        forceX<SnowballNode>((d) =>
          layout === "timeline" && yearScale && d.year
            ? yearScale.x(d.year)
            : W / 2
        ).strength((d) =>
          layout === "timeline" && yearScale ? (d.year ? 0.55 : 0.08) : 0.045
        )
      )
      .force("y", forceY<SnowballNode>(H / 2).strength(0.06));
    // Settle synchronously so the map opens already composed.
    sim.stop();
    for (let i = 0; i < 300; i++) sim.tick();
    sim.on("tick", () => setFrame((f) => f + 1));
    simRef.current = sim;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setFrame((f) => f + 1);
    return () => {
      sim.stop();
    };
  }, [data, layout, yearScale]);

  // ------------------------------------------------------------------
  // Interaction: pan, zoom, drag; hover and selection.
  // ------------------------------------------------------------------
  function onWheel(e: React.WheelEvent) {
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    const k = Math.max(0.25, Math.min(4, view.k * factor));
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    const px = ((e.clientX - rect.left) / rect.width) * W;
    const py = ((e.clientY - rect.top) / rect.height) * H;
    // Keep the point under the cursor fixed while zooming.
    setView((v) => ({
      k,
      x: px - ((px - v.x) / v.k) * k,
      y: py - ((py - v.y) / v.k) * k,
    }));
  }

  function onPointerDown(e: React.PointerEvent, nodeId?: string) {
    (e.target as Element).setPointerCapture?.(e.pointerId);
    dragRef.current = {
      id: nodeId ?? null,
      panning: !nodeId,
      lastX: e.clientX,
      lastY: e.clientY,
      moved: false,
    };
    if (nodeId && simRef.current) {
      const n = data?.nodes.find((x) => x.id === nodeId);
      if (n) {
        n.fx = n.x;
        n.fy = n.y;
      }
      setDraggingNode(true);
      simRef.current.alphaTarget(0.25).restart();
    }
  }

  function onPointerMove(e: React.PointerEvent) {
    const d = dragRef.current;
    if (!d.panning && !d.id) {
      return;
    }
    const dx = e.clientX - d.lastX;
    const dy = e.clientY - d.lastY;
    if (Math.abs(dx) + Math.abs(dy) > 2) d.moved = true;
    d.lastX = e.clientX;
    d.lastY = e.clientY;
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    const sx = (dx / rect.width) * W;
    const sy = (dy / rect.height) * H;
    if (d.panning) {
      setView((v) => ({ ...v, x: v.x + sx, y: v.y + sy }));
    } else if (d.id) {
      const n = data?.nodes.find((x) => x.id === d.id);
      if (n) {
        n.fx = (n.fx ?? n.x ?? 0) + sx / view.k;
        n.fy = (n.fy ?? n.y ?? 0) + sy / view.k;
      }
    }
  }

  function onPointerUp() {
    const d = dragRef.current;
    if (d.id) {
      const n = data?.nodes.find((x) => x.id === d.id);
      if (n) {
        n.fx = null;
        n.fy = null;
      }
      simRef.current?.alphaTarget(0);
      setDraggingNode(false);
      if (!d.moved) {
        setSelectedId((s) => (s === d.id ? null : d.id));
      }
    } else if (d.panning && !d.moved) {
      setSelectedId(null);
    }
    dragRef.current = { id: null, panning: false, lastX: 0, lastY: 0, moved: false };
  }

  // ------------------------------------------------------------------
  // Derived visibility
  // ------------------------------------------------------------------
  const nodes = useMemo(() => data?.nodes ?? [], [data]);
  const edges = useMemo(() => data?.edges ?? [], [data]);
  const q = search.trim().toLowerCase();

  const nodeVisible = useCallback(
    (n: SnowballNode) => n.isSeed || statusOn[n.status],
    [statusOn]
  );
  const visibleIds = useMemo(
    () => new Set(nodes.filter(nodeVisible).map((n) => n.id)),
    [nodes, nodeVisible]
  );
  const edgeVisible = (e: SnowballEdge) =>
    (e.direction === "backward" ? showBackward : showForward) &&
    visibleIds.has(e.seedId) &&
    visibleIds.has(e.recordId);

  // Focus: a selected node dims everything outside its neighborhood;
  // a search dims non-matches.
  const neighborhood = useMemo(() => {
    if (!selectedId) return null;
    const set = new Set<string>([selectedId]);
    edges.forEach((e) => {
      if (e.seedId === selectedId) set.add(e.recordId);
      if (e.recordId === selectedId) set.add(e.seedId);
    });
    return set;
  }, [selectedId, edges]);

  const emphasis = (n: SnowballNode): number => {
    if (q) {
      return n.title.toLowerCase().includes(q) ||
        (n.authors ?? "").toLowerCase().includes(q) ||
        n.label.toLowerCase().includes(q)
        ? 1
        : 0.14;
    }
    if (neighborhood) return neighborhood.has(n.id) ? 1 : 0.12;
    return 1;
  };

  const selected = selectedId
    ? (nodes.find((n) => n.id === selectedId) ?? null)
    : null;
  const selectedEdges = selected
    ? edges.filter(
        (e) => e.seedId === selected.id || e.recordId === selected.id
      )
    : [];
  const hovered = hoverId ? (nodes.find((n) => n.id === hoverId) ?? null) : null;

  const fillOf = (n: SnowballNode): string =>
    n.status === "conflict" ? pal.included : pal[n.status];

  const counts = useMemo(() => {
    const c = { seeds: 0, backward: 0, forward: 0, openalex: 0, file: 0, manual: 0 };
    nodes.forEach((n) => {
      if (n.isSeed) c.seeds++;
      else if (n.source === "openalex") c.openalex++;
      else if (n.source === "file") c.file++;
      else if (n.source === "manual") c.manual++;
    });
    edges.forEach((e) => {
      if (e.direction === "backward") c.backward++;
      else c.forward++;
    });
    return c;
  }, [nodes, edges]);

  // ------------------------------------------------------------------
  // Node shape by source: circle (OpenAlex or seed), rounded square
  // (export file), diamond (manual entry).
  // ------------------------------------------------------------------
  function NodeShape({ n }: { n: SnowballNode }) {
    const r = nodeRadius(n);
    const fill = fillOf(n);
    const common = {
      stroke: n.isSeed ? pal.ink : pal.surfaceRing,
      strokeWidth: n.isSeed ? 2.5 : 1,
    };
    if (n.status === "conflict") {
      // Split node: left half included green, right half excluded red;
      // the two-tone shape IS the conflict mark, not a third hue.
      return (
        <g>
          <path
            d={`M 0 ${-r} A ${r} ${r} 0 0 0 0 ${r} Z`}
            fill={pal.included}
            {...common}
          />
          <path
            d={`M 0 ${-r} A ${r} ${r} 0 0 1 0 ${r} Z`}
            fill={pal.excluded}
            {...common}
          />
        </g>
      );
    }
    if (!n.isSeed && n.source === "file") {
      const s = r * 1.72;
      return (
        <rect
          x={-s / 2}
          y={-s / 2}
          width={s}
          height={s}
          rx={3}
          fill={fill}
          {...common}
        />
      );
    }
    if (!n.isSeed && n.source === "manual") {
      return (
        <path
          d={`M 0 ${-r * 1.2} L ${r * 1.2} 0 L 0 ${r * 1.2} L ${-r * 1.2} 0 Z`}
          fill={fill}
          {...common}
        />
      );
    }
    return <circle r={r} fill={fill} {...common} />;
  }

  // ------------------------------------------------------------------
  const chip = (on: boolean) =>
    `rounded-full border px-2.5 py-0.5 text-xs transition-colors ${
      on
        ? "border-teal-600 bg-teal-50 text-teal-800 dark:border-teal-500 dark:bg-teal-950 dark:text-teal-200"
        : "border-zinc-300 text-zinc-500 dark:border-zinc-700 dark:text-zinc-400"
    }`;

  if (error) {
    return (
      <p className="mb-6 rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
        Citation map: {error}
      </p>
    );
  }
  if (!data) {
    return (
      <p className="mb-6 text-sm text-zinc-500 dark:text-zinc-400">
        Drawing the citation map...
      </p>
    );
  }
  if (data.nodes.length === 0) {
    return (
      <div className="mb-6 rounded-xl border border-zinc-200 bg-white p-5 text-sm text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
        The citation map draws itself once snowball rounds create links:
        every seed and every found record become nodes, connected by who
        cited whom. Run a snowball round below to start it.
      </div>
    );
  }

  const invisible = nodes.length - visibleIds.size;

  return (
    <div
      data-frame={frame}
      className="mb-6 rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900"
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
        <h2 className="mr-1 text-sm font-semibold text-zinc-900 dark:text-zinc-50">
          Citation map
        </h2>
        <span className="text-xs tabular-nums text-zinc-500 dark:text-zinc-400">
          {counts.seeds} seeds · {counts.backward} backward · {counts.forward}{" "}
          forward
          {counts.openalex + counts.file + counts.manual > 0 &&
            ` · via OpenAlex ${counts.openalex}, files ${counts.file}, manual ${counts.manual}`}
        </span>
        <button
          onClick={() => setCollapsed((c) => !c)}
          className="ml-auto text-xs text-zinc-500 underline underline-offset-2 dark:text-zinc-400"
        >
          {collapsed ? "show map" : "hide map"}
        </button>
      </div>

      {!collapsed && (
        <>
          {/* Filter row */}
          <div className="flex flex-wrap items-center gap-2 border-b border-zinc-200 px-4 py-2.5 dark:border-zinc-800">
            <button
              onClick={() => setShowBackward((v) => !v)}
              className={chip(showBackward)}
            >
              backward
            </button>
            <button
              onClick={() => setShowForward((v) => !v)}
              className={chip(showForward)}
            >
              forward
            </button>
            <span className="mx-1 h-4 w-px bg-zinc-200 dark:bg-zinc-700" />
            {(
              [
                "included",
                "excluded",
                "conflict",
                "screening",
                "prescreened",
              ] as MapStatus[]
            ).map((s) => (
              <button
                key={s}
                onClick={() =>
                  setStatusOn((m) => ({ ...m, [s]: !m[s] }))
                }
                className={chip(statusOn[s])}
              >
                {STATUS_LABEL[s]}
              </button>
            ))}
            <span className="mx-1 h-4 w-px bg-zinc-200 dark:bg-zinc-700" />
            <button
              onClick={() =>
                setLayout((l) => (l === "network" ? "timeline" : "network"))
              }
              className={chip(layout === "timeline")}
              title="Timeline pins each paper to its publication year on the horizontal axis"
              disabled={!yearScale}
            >
              timeline
            </button>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Find a paper..."
              className="ml-auto h-7 w-44 rounded-lg border border-zinc-300 bg-white px-2 text-xs text-zinc-900 outline-none focus:border-teal-600 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50"
            />
            <button
              onClick={() => {
                setView({ x: 0, y: 0, k: 1 });
                setSelectedId(null);
                setSearch("");
              }}
              className="rounded-full border border-zinc-300 px-2.5 py-0.5 text-xs text-zinc-600 dark:border-zinc-700 dark:text-zinc-400"
            >
              reset view
            </button>
          </div>

          <div className="relative flex">
            <svg
              ref={svgRef}
              viewBox={`0 0 ${W} ${H}`}
              className="h-[68vh] min-h-[420px] w-full min-w-0 cursor-grab touch-none select-none active:cursor-grabbing"
              onWheel={onWheel}
              onPointerDown={(e) => onPointerDown(e)}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerLeave={() => {
                setHoverId(null);
                setHoverPos(null);
              }}
              role="img"
              aria-label="Snowball citation map"
            >
              <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
                {/* Timeline axis */}
                {layout === "timeline" && yearScale && (
                  <g>
                    {Array.from(
                      { length: yearScale.max - yearScale.min + 1 },
                      (_, i) => yearScale.min + i
                    )
                      .filter(
                        (y, _, arr) =>
                          arr.length <= 12 ||
                          y % Math.ceil(arr.length / 12) === 0
                      )
                      .map((y) => (
                        <g key={y}>
                          <line
                            x1={yearScale.x(y)}
                            x2={yearScale.x(y)}
                            y1={30}
                            y2={H - 34}
                            stroke={pal.edge}
                            strokeOpacity={0.18}
                          />
                          <text
                            x={yearScale.x(y)}
                            y={H - 16}
                            textAnchor="middle"
                            fontSize={12}
                            fill={pal.label}
                          >
                            {y}
                          </text>
                        </g>
                      ))}
                  </g>
                )}

                {/* Edges under nodes */}
                {edges.filter(edgeVisible).map((e) => {
                  const s = e.source as SnowballNode;
                  const t = e.target as SnowballNode;
                  if (typeof s === "string" || typeof t === "string")
                    return null;
                  const op =
                    0.35 * Math.min(emphasis(s), emphasis(t)) +
                    (selectedId &&
                    (e.seedId === selectedId || e.recordId === selectedId)
                      ? 0.45
                      : 0);
                  return (
                    <line
                      key={e.id}
                      x1={s.x}
                      y1={s.y}
                      x2={t.x}
                      y2={t.y}
                      stroke={pal.edge}
                      strokeWidth={
                        selectedId &&
                        (e.seedId === selectedId || e.recordId === selectedId)
                          ? 2
                          : 1.2
                      }
                      strokeOpacity={op}
                      strokeDasharray={
                        e.direction === "forward" ? "5 4" : undefined
                      }
                    />
                  );
                })}

                {/* Nodes */}
                {nodes.filter(nodeVisible).map((n) => (
                  <g
                    key={n.id}
                    transform={`translate(${n.x ?? 0} ${n.y ?? 0})`}
                    opacity={emphasis(n)}
                    className="cursor-pointer"
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      onPointerDown(e, n.id);
                    }}
                    onPointerEnter={(e) => {
                      setHoverId(n.id);
                      const rect = svgRef.current?.getBoundingClientRect();
                      if (rect) {
                        setHoverPos({
                          x: e.clientX - rect.left,
                          y: e.clientY - rect.top,
                        });
                      }
                    }}
                    onPointerLeave={() => {
                      setHoverId(null);
                      setHoverPos(null);
                    }}
                  >
                    {/* Oversized invisible hit target */}
                    <circle
                      r={nodeRadius(n) + 7}
                      fill="transparent"
                      stroke="none"
                    />
                    <NodeShape n={n} />
                    {(n.isSeed ||
                      view.k >= 1.25 ||
                      n.id === hoverId ||
                      n.id === selectedId) && (
                      <text
                        y={nodeRadius(n) + 13}
                        textAnchor="middle"
                        fontSize={n.isSeed ? 12.5 : 11}
                        fontWeight={n.isSeed ? 600 : 400}
                        fill={pal.label}
                        stroke={pal.surfaceRing}
                        strokeWidth={3}
                        paintOrder="stroke"
                      >
                        {n.label}
                      </text>
                    )}
                  </g>
                ))}
              </g>
            </svg>

            {/* Hover tooltip */}
            {hovered && hoverPos && !draggingNode && (
              <div
                className="pointer-events-none absolute z-10 max-w-72 rounded-lg border border-zinc-200 bg-white px-3 py-2 text-xs shadow-lg dark:border-zinc-700 dark:bg-zinc-950"
                style={{
                  left: Math.min(hoverPos.x + 14, 900),
                  top: hoverPos.y + 10,
                }}
              >
                <p className="mb-0.5 font-medium text-zinc-900 dark:text-zinc-50">
                  {hovered.title}
                </p>
                <p className="text-zinc-600 dark:text-zinc-400">
                  {[hovered.authors, hovered.year].filter(Boolean).join(" · ")}
                </p>
                <p className="mt-1 text-zinc-600 dark:text-zinc-400">
                  {hovered.isSeed
                    ? `Seed paper · ${hovered.degree} connection(s)`
                    : `${STATUS_LABEL[hovered.status]} · via ${SOURCE_LABEL[hovered.source]} · found from ${hovered.degree} seed(s)`}
                </p>
              </div>
            )}

            {/* Detail panel */}
            {selected && (
              <aside className="absolute right-3 top-3 z-10 w-72 rounded-xl border border-zinc-200 bg-white p-4 text-sm shadow-lg dark:border-zinc-700 dark:bg-zinc-950">
                <div className="mb-1 flex items-start justify-between gap-2">
                  <p className="font-semibold leading-snug text-zinc-900 dark:text-zinc-50">
                    {selected.title}
                  </p>
                  <button
                    onClick={() => setSelectedId(null)}
                    aria-label="Close"
                    className="rounded-full px-1.5 text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                  >
                    ✕
                  </button>
                </div>
                <p className="mb-2 text-xs text-zinc-600 dark:text-zinc-400">
                  {[selected.authors, selected.year]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
                <p className="mb-2 text-xs text-zinc-700 dark:text-zinc-300">
                  {selected.isSeed
                    ? "Seed paper (included after full text)"
                    : `Status: ${STATUS_LABEL[selected.status]} · entered via ${SOURCE_LABEL[selected.source]}`}
                </p>
                {selectedEdges.length > 0 && (
                  <div className="mb-2 max-h-40 overflow-y-auto text-xs text-zinc-600 dark:text-zinc-400">
                    {selectedEdges.slice(0, 12).map((e) => {
                      const otherId =
                        e.seedId === selected.id ? e.recordId : e.seedId;
                      const other = nodes.find((n) => n.id === otherId);
                      if (!other) return null;
                      const phrase =
                        e.direction === "backward"
                          ? e.seedId === selected.id
                            ? `cites ${other.label}`
                            : `cited by seed ${other.label}`
                          : e.seedId === selected.id
                            ? `cited by ${other.label}`
                            : `cites seed ${other.label}`;
                      return <p key={e.id}>· {phrase}</p>;
                    })}
                    {selectedEdges.length > 12 && (
                      <p>· and {selectedEdges.length - 12} more</p>
                    )}
                  </div>
                )}
                <Link
                  href={`/projects/${project.id}/records`}
                  className="text-xs text-teal-700 underline underline-offset-2 dark:text-teal-300"
                >
                  Open the records table
                </Link>
              </aside>
            )}
          </div>

          {/* Legend */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t border-zinc-200 px-4 py-2.5 text-xs text-zinc-600 dark:border-zinc-800 dark:text-zinc-400">
            <span className="inline-flex items-center gap-1.5">
              <svg width="14" height="14" viewBox="-7 -7 14 14">
                <circle r="5.5" fill={pal.included} stroke={pal.ink} strokeWidth="1.8" />
              </svg>
              seed
            </span>
            <span className="inline-flex items-center gap-1.5">
              <svg width="12" height="12" viewBox="-6 -6 12 12">
                <circle r="5" fill={pal.included} />
              </svg>
              included
            </span>
            <span className="inline-flex items-center gap-1.5">
              <svg width="12" height="12" viewBox="-6 -6 12 12">
                <circle r="5" fill={pal.excluded} />
              </svg>
              excluded
            </span>
            <span className="inline-flex items-center gap-1.5">
              <svg width="12" height="12" viewBox="-6 -6 12 12">
                <path d="M 0 -5 A 5 5 0 0 0 0 5 Z" fill={pal.included} />
                <path d="M 0 -5 A 5 5 0 0 1 0 5 Z" fill={pal.excluded} />
              </svg>
              conflict
            </span>
            <span className="inline-flex items-center gap-1.5">
              <svg width="12" height="12" viewBox="-6 -6 12 12">
                <circle r="5" fill={pal.screening} />
              </svg>
              in screening
            </span>
            <span className="inline-flex items-center gap-1.5">
              <svg width="12" height="12" viewBox="-6 -6 12 12">
                <circle r="5" fill={pal.prescreened} />
              </svg>
              AI prescreened
            </span>
            <span className="mx-1 h-4 w-px bg-zinc-200 dark:bg-zinc-700" />
            <span className="inline-flex items-center gap-1.5">
              <svg width="12" height="12" viewBox="-6 -6 12 12">
                <circle r="5" fill={pal.screening} />
              </svg>
              OpenAlex
            </span>
            <span className="inline-flex items-center gap-1.5">
              <svg width="12" height="12" viewBox="-6 -6 12 12">
                <rect x="-4.5" y="-4.5" width="9" height="9" rx="2" fill={pal.screening} />
              </svg>
              export file
            </span>
            <span className="inline-flex items-center gap-1.5">
              <svg width="12" height="12" viewBox="-6 -6 12 12">
                <path d="M 0 -5.5 L 5.5 0 L 0 5.5 L -5.5 0 Z" fill={pal.screening} />
              </svg>
              manual
            </span>
            <span className="mx-1 h-4 w-px bg-zinc-200 dark:bg-zinc-700" />
            <span className="inline-flex items-center gap-1.5">
              <svg width="26" height="8" viewBox="0 0 26 8">
                <line x1="1" y1="4" x2="25" y2="4" stroke={pal.edge} strokeWidth="1.6" />
              </svg>
              seed cites it (backward)
            </span>
            <span className="inline-flex items-center gap-1.5">
              <svg width="26" height="8" viewBox="0 0 26 8">
                <line x1="1" y1="4" x2="25" y2="4" stroke={pal.edge} strokeWidth="1.6" strokeDasharray="4 3" />
              </svg>
              cites the seed (forward)
            </span>
            {invisible > 0 && (
              <span className="ml-auto">{invisible} node(s) filtered out</span>
            )}
          </div>
        </>
      )}
    </div>
  );
}
