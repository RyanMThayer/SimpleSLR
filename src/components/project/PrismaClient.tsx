"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { card, btnSecondary as exportBtn } from "@/lib/ui";
import { buildCsv, buildRis, downloadFile, slugify } from "@/lib/export";
import {
  decisionsByRecord,
  requiredFor,
  settledOutcome,
} from "@/lib/outcomes";
import { resKey } from "@/lib/resolutions";
import { buildPrismaSummary, formatLongDate } from "@/lib/prismaSummary";
import type {
  ExclusionReason,
  ImportBatch,
  Profile,
  Project,
  ProjectDatabase,
  RecordRow,
  ScreeningDecision,
  ScreeningResolution,
} from "@/lib/types";
import { fetchResolutions } from "@/lib/resolutions";

type Data = {
  records: RecordRow[];
  decisions: ScreeningDecision[];
  // Conflict resolutions keyed stage:record_id, and the opinions each
  // stage requires: PRISMA counts SETTLED outcomes only, so records
  // still blinded or in unresolved conflict stay "in screening".
  resolutions: Map<string, ScreeningResolution>;
  requiredTa: number;
  requiredFt: number;
  prescreenModels: string[];
  reasons: ExclusionReason[];
  databases: ProjectDatabase[];
  batches: ImportBatch[];
  profiles: Map<string, Profile>;
};

/** One PRISMA 2020 arm: via databases, or via other methods (snowballing). */
type ArmCounts = {
  identified: number;
  backward: number;
  forward: number;
  duplicates: number;
  autoExcluded: number;
  screened: number;
  taExcluded: number;
  sought: number;
  notRetrieved: number;
  assessed: number;
  ftExcluded: number;
  ftExcludedByReason: { label: string; count: number }[];
  ftIncluded: number;
};

type Counts = {
  identified: number;
  viaSnowball: number;
  db: ArmCounts;
  other: ArmCounts;
  perSource: { name: string; imported: number; rawHits: number | null; snowball: boolean }[];
  duplicates: number;
  screened: number;
  taExcluded: number;
  taIncluded: number;
  taConflicts: number;
  taUndecided: number;
  notRetrieved: number;
  assessed: number;
  ftExcludedByReason: { label: string; count: number }[];
  ftExcluded: number;
  ftIncluded: number;
  ftUndecided: number;
  taRecordIds: Set<string>;
  ftRecordIds: Set<string>;
};

async function fetchPaged<T>(
  build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>
): Promise<T[]> {
  const out: T[] = [];
  const page = 1000;
  for (let from = 0; ; from += page) {
    const { data, error } = await build(from, from + page - 1);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < page) break;
  }
  return out;
}

function computeCounts(d: Data): Counts {
  const duplicates = d.records.filter((r) => r.status === "duplicate").length;

  // Batches created before the snowball migration have no origin column;
  // treat those as ordinary database imports.
  const snowballBatchIds = new Set(
    d.batches.filter((b) => b.origin?.startsWith("snowball")).map((b) => b.id)
  );
  const backwardBatchIds = new Set(
    d.batches.filter((b) => b.origin === "snowball_backward").map((b) => b.id)
  );
  const isSnow = (r: RecordRow) =>
    Boolean(r.batch_id && snowballBatchIds.has(r.batch_id));

  const mkArm = (): ArmCounts => ({
    identified: 0,
    backward: 0,
    forward: 0,
    duplicates: 0,
    autoExcluded: 0,
    screened: 0,
    taExcluded: 0,
    sought: 0,
    notRetrieved: 0,
    assessed: 0,
    ftExcluded: 0,
    ftExcludedByReason: [],
    ftIncluded: 0,
  });
  const db = mkArm();
  const other = mkArm();
  const dbReasonCounts = new Map<string, number>();
  const otherReasonCounts = new Map<string, number>();

  const taMap = decisionsByRecord(d.decisions, "title_abstract");
  let taExcluded = 0,
    taIncluded = 0,
    taConflicts = 0,
    taUndecided = 0;
  const taRecordIds = new Set<string>();
  for (const r of d.records) {
    const arm = isSnow(r) ? other : db;
    arm.identified++;
    if (arm === other) {
      if (r.batch_id && backwardBatchIds.has(r.batch_id)) arm.backward++;
      else arm.forward++;
    }
    if (r.status === "duplicate") {
      arm.duplicates++;
      continue;
    }
    if (r.status === "prescreen_excluded") {
      // PRISMA 2020: "records marked as ineligible by automation
      // tools", removed before screening.
      arm.autoExcluded++;
      continue;
    }
    arm.screened++;
    const o = settledOutcome(
      taMap.get(r.id) ?? [],
      d.resolutions.get(resKey("title_abstract", r.id)),
      d.requiredTa
    );
    if (o === "excluded") {
      taExcluded++;
      arm.taExcluded++;
    } else if (o === "included") {
      taIncluded++;
      arm.sought++;
      taRecordIds.add(r.id);
    } else if (o === "conflict") taConflicts++;
    else taUndecided++;
  }

  const ftMap = decisionsByRecord(d.decisions, "full_text");
  const reasonLabel = new Map(d.reasons.map((r) => [r.id, r.label]));
  const recById = new Map(d.records.map((r) => [r.id, r]));
  let ftExcluded = 0,
    ftIncluded = 0,
    ftUndecided = 0,
    notRetrieved = 0;
  const ftRecordIds = new Set<string>();
  for (const id of taRecordIds) {
    const rec = recById.get(id);
    const arm = rec && isSnow(rec) ? other : db;
    const reasonCounts = arm === other ? otherReasonCounts : dbReasonCounts;
    if (rec?.retrieval_status === "not_retrieved") {
      notRetrieved++;
      arm.notRetrieved++;
      continue;
    }
    const decs = ftMap.get(id) ?? [];
    const res = d.resolutions.get(resKey("full_text", id));
    const o = settledOutcome(decs, res, d.requiredFt);
    if (o === "excluded") {
      ftExcluded++;
      arm.ftExcluded++;
      // A resolution's reason wins: it is the team's final word.
      const withReason =
        res && res.decision === "exclude" && res.reason_id
          ? res
          : decs.find((x) => x.decision === "exclude" && x.reason_id);
      const label = withReason?.reason_id
        ? (reasonLabel.get(withReason.reason_id) ?? "Removed reason")
        : "No reason recorded";
      reasonCounts.set(label, (reasonCounts.get(label) ?? 0) + 1);
    } else if (o === "included") {
      ftIncluded++;
      arm.ftIncluded++;
      ftRecordIds.add(id);
    } else {
      ftUndecided++;
    }
  }
  db.assessed = db.sought - db.notRetrieved;
  other.assessed = other.sought - other.notRetrieved;
  const toSorted = (m: Map<string, number>) =>
    [...m.entries()]
      .map(([label, count]) => ({ label, count }))
      .sort((a, b) => b.count - a.count);
  db.ftExcludedByReason = toSorted(dbReasonCounts);
  other.ftExcludedByReason = toSorted(otherReasonCounts);

  const dbById = new Map(d.databases.map((x) => [x.id, x]));
  const perSourceMap = new Map<
    string,
    { imported: number; rawHits: number | null; snowball: boolean }
  >();
  for (const b of d.batches) {
    const name = b.database_id
      ? (dbById.get(b.database_id)?.name ?? "Removed database")
      : (b.source_label ?? "Unlinked imports");
    const entry = perSourceMap.get(name) ?? {
      imported: 0,
      rawHits: b.database_id ? (dbById.get(b.database_id)?.raw_hit_count ?? null) : null,
      snowball: Boolean(b.origin?.startsWith("snowball")),
    };
    entry.imported += b.record_count;
    // Snowball batches carry their own candidate counts (0011 onward),
    // so the table can show found vs imported for those rounds too.
    if (!b.database_id && b.raw_hit_count != null) {
      entry.rawHits = (entry.rawHits ?? 0) + b.raw_hit_count;
    }
    perSourceMap.set(name, entry);
  }

  const merged = new Map<string, number>();
  [...dbReasonCounts, ...otherReasonCounts].forEach(([l, n]) =>
    merged.set(l, (merged.get(l) ?? 0) + n)
  );

  return {
    identified: d.records.length,
    viaSnowball: other.identified,
    db,
    other,
    perSource: [...perSourceMap.entries()].map(([name, v]) => ({ name, ...v })),
    duplicates,
    screened: db.screened + other.screened,
    taExcluded,
    taIncluded,
    taConflicts,
    taUndecided,
    notRetrieved,
    assessed: taIncluded - notRetrieved,
    ftExcludedByReason: toSorted(merged),
    ftExcluded,
    ftIncluded,
    ftUndecided,
    taRecordIds,
    ftRecordIds,
  };
}

// ----------------------------------------------------------------------
// SVG diagram
// ----------------------------------------------------------------------

type Box = {
  x: number;
  y: number;
  w: number;
  h: number;
  lines: string[];
  /** Render as a column header: shaded, centered, no border. */
  header?: boolean;
  /** Rotated stage band label (Identification / Screening / Included). */
  vertical?: boolean;
};

/** Polyline points; the arrowhead sits on the final point. */
type Arrow = [number, number][];

type Diagram = { boxes: Box[]; arrows: Arrow[]; width: number; height: number };

const LINE = 16;
const PAD = 10;
const GAP = 26;
const LANE_X = 14;
const LANE_W = 26;

function wrapLine(line: string, maxChars: number): string[] {
  if (line.length <= maxChars) return [line];
  const words = line.split(" ");
  const out: string[] = [];
  let cur = "";
  for (const word of words) {
    if (cur && (cur + " " + word).length > maxChars) {
      out.push(cur);
      cur = word;
    } else {
      cur = cur ? `${cur} ${word}` : word;
    }
  }
  if (cur) out.push(cur);
  return out;
}

function mkBox(x: number, w: number, lines: string[]): Omit<Box, "y"> {
  // Word-wrap to the box width so long reason labels or source names
  // can never spill into a neighboring column.
  const maxChars = Math.max(12, Math.floor((w - PAD * 2) / 6.6));
  const wrapped = lines.flatMap((l) => wrapLine(l, maxChars));
  return { x, w, h: wrapped.length * LINE + PAD * 2, lines: wrapped };
}

/**
 * The "Reports excluded" side box. A genuine zero reads as an explicit
 * n = 0 rather than a placeholder: all full text reports passing, or
 * none reaching the stage at all, are real reportable outcomes.
 */
function reportsExcludedLines(arm: ArmCounts): string[] {
  if (arm.ftExcluded === 0) return ["Reports excluded (n = 0)"];
  const lines = arm.ftExcludedByReason
    .slice(0, 12)
    .map((r) => `${r.label} (n = ${r.count})`);
  if (arm.ftExcludedByReason.length > 12) lines.push("and more reasons");
  return [`Reports excluded (n = ${arm.ftExcluded}):`, ...lines];
}

function sourceLines(c: Counts): string[] {
  const dbSources = c.perSource.filter((s) => !s.snowball);
  const lines = dbSources.slice(0, 6).map((s) => `${s.name} (n = ${s.imported})`);
  if (dbSources.length > 6) lines.push("and more sources");
  return lines;
}

/**
 * Row engine: each row is placed with a height that accounts for EVERY
 * box in it (side boxes included), so nothing can overlap; boxes are
 * vertically centered within their row.
 */
type RowBoxes = Omit<Box, "y">[];

function placeRows(
  rows: RowBoxes[],
  startY: number
): { placed: Box[][]; y: number } {
  const placed: Box[][] = [];
  let y = startY;
  for (const row of rows) {
    const rowH = Math.max(...row.map((b) => b.h));
    placed.push(row.map((b) => ({ ...b, y: y + (rowH - b.h) / 2 })));
    y += rowH + GAP;
  }
  return { placed, y };
}

function midX(b: Box): number {
  return b.x + b.w / 2;
}

/** Vertical stage bands on the far left, PRISMA 2020 style. */
function stageBands(
  identTop: number,
  identBottom: number,
  screenBottom: number,
  inclBottom: number
): Box[] {
  const mk = (label: string, top: number, bottom: number): Box => ({
    x: LANE_X,
    y: top,
    w: LANE_W,
    h: bottom - top,
    lines: [label],
    header: true,
    vertical: true,
  });
  return [
    mk("Identification", identTop, identBottom),
    mk("Screening", identBottom + 8, screenBottom),
    mk("Included", screenBottom + 8, inclBottom),
  ];
}

function layoutDiagram(c: Counts): Diagram {
  return c.other.identified > 0 ? layoutTwoArms(c) : layoutSingleArm(c);
}

/** PRISMA 2020, databases and registers only. */
function layoutSingleArm(c: Counts): Diagram {
  const MAIN_X = LANE_X + LANE_W + 14;
  const MAIN_W = 330;
  const SIDE_X = MAIN_X + MAIN_W + 50;
  const SIDE_W = 300;
  const width = SIDE_X + SIDE_W + 20;

  const HEAD_H = 30;
  const headerTop = 16;
  const header: Box = {
    x: MAIN_X,
    y: headerTop,
    w: SIDE_X + SIDE_W - MAIN_X,
    h: HEAD_H,
    lines: ["Identification of studies via databases and registers"],
    header: true,
  };

  const rows: RowBoxes[] = [
    [
      mkBox(MAIN_X, MAIN_W, [
        "Records identified from:",
        `Databases (n = ${c.db.identified})`,
        ...sourceLines(c),
      ]),
      mkBox(SIDE_X, SIDE_W, [
        "Records removed before screening:",
        `Duplicate records removed (n = ${c.db.duplicates})`,
        `Records marked as ineligible by automation tools (n = ${c.db.autoExcluded})`,
      ]),
    ],
    [
      mkBox(MAIN_X, MAIN_W, [`Records screened (n = ${c.db.screened})`]),
      mkBox(SIDE_X, SIDE_W, [`Records excluded (n = ${c.db.taExcluded})`]),
    ],
    [
      mkBox(MAIN_X, MAIN_W, ["Reports sought for retrieval", `(n = ${c.db.sought})`]),
      mkBox(SIDE_X, SIDE_W, ["Reports not retrieved", `(n = ${c.db.notRetrieved})`]),
    ],
    [
      mkBox(MAIN_X, MAIN_W, ["Reports assessed for eligibility", `(n = ${c.db.assessed})`]),
      mkBox(SIDE_X, SIDE_W, reportsExcludedLines(c.db)),
    ],
    [
      mkBox(MAIN_X, MAIN_W, [
        `Studies included in review (n = ${c.db.ftIncluded})`,
        `Reports of included studies (n = ${c.db.ftIncluded})`,
      ]),
    ],
  ];
  const { placed, y } = placeRows(rows, headerTop + HEAD_H + 18);
  const height = y - GAP + 20;

  const mains = placed.map((row) => row[0]);
  const arrows: Arrow[] = [];
  for (let i = 0; i < mains.length - 1; i++) {
    arrows.push([
      [midX(mains[i]), mains[i].y + mains[i].h],
      [midX(mains[i + 1]), mains[i + 1].y],
    ]);
  }
  for (let i = 0; i < 4; i++) {
    const side = placed[i][1];
    arrows.push([
      [MAIN_X + MAIN_W, side.y + side.h / 2],
      [side.x, side.y + side.h / 2],
    ]);
  }

  const bands = stageBands(
    headerTop,
    Math.max(...placed[0].map((b) => b.y + b.h)),
    placed[4][0].y - GAP / 2,
    height - 20
  );

  return {
    boxes: [header, ...bands, ...placed.flat()],
    arrows,
    width,
    height,
  };
}

/**
 * PRISMA 2020 two column template: databases and registers on the
 * left, other methods (citation searching) on the right. Per the
 * template, the other methods column has no screening or duplicate
 * boxes: identified records go straight to retrieval.
 */
function layoutTwoArms(c: Counts): Diagram {
  const MAIN_X = LANE_X + LANE_W + 14;
  const MAIN_W = 300;
  const S1_X = MAIN_X + MAIN_W + 36;
  const S1_W = 240;
  const OTH_X = S1_X + S1_W + 36;
  const OTH_W = 300;
  const S2_X = OTH_X + OTH_W + 36;
  const S2_W = 240;
  const width = S2_X + S2_W + 20;

  const HEAD_H = 30;
  const headerTop = 16;
  const headers: Box[] = [
    {
      x: MAIN_X,
      y: headerTop,
      w: S1_X + S1_W - MAIN_X,
      h: HEAD_H,
      lines: ["Identification of studies via databases and registers"],
      header: true,
    },
    {
      x: OTH_X,
      y: headerTop,
      w: S2_X + S2_W - OTH_X,
      h: HEAD_H,
      lines: ["Identification of studies via other methods"],
      header: true,
    },
  ];

  // Row composition; positions in each row are found by x lane below.
  const rows: RowBoxes[] = [
    [
      mkBox(MAIN_X, MAIN_W, [
        "Records identified from:",
        `Databases (n = ${c.db.identified})`,
        ...sourceLines(c),
      ]),
      mkBox(S1_X, S1_W, [
        "Records removed before screening:",
        `Duplicate records removed (n = ${c.db.duplicates})`,
        `Records marked as ineligible by automation tools (n = ${c.db.autoExcluded})`,
      ]),
      mkBox(OTH_X, OTH_W, [
        "Records identified from:",
        `Citation searching (n = ${c.other.identified})`,
      ]),
    ],
    [
      mkBox(MAIN_X, MAIN_W, [`Records screened (n = ${c.db.screened})`]),
      mkBox(S1_X, S1_W, [`Records excluded (n = ${c.db.taExcluded})`]),
    ],
    [
      mkBox(MAIN_X, MAIN_W, ["Reports sought for retrieval", `(n = ${c.db.sought})`]),
      mkBox(S1_X, S1_W, ["Reports not retrieved", `(n = ${c.db.notRetrieved})`]),
      mkBox(OTH_X, OTH_W, ["Reports sought for retrieval", `(n = ${c.other.sought})`]),
      mkBox(S2_X, S2_W, ["Reports not retrieved", `(n = ${c.other.notRetrieved})`]),
    ],
    [
      mkBox(MAIN_X, MAIN_W, ["Reports assessed for eligibility", `(n = ${c.db.assessed})`]),
      mkBox(S1_X, S1_W, reportsExcludedLines(c.db)),
      mkBox(OTH_X, OTH_W, ["Reports assessed for eligibility", `(n = ${c.other.assessed})`]),
      mkBox(S2_X, S2_W, reportsExcludedLines(c.other)),
    ],
    [
      mkBox(MAIN_X, MAIN_W, [
        `Studies included in review (n = ${c.db.ftIncluded + c.other.ftIncluded})`,
        `Reports of included studies (n = ${c.db.ftIncluded + c.other.ftIncluded})`,
      ]),
    ],
  ];
  const { placed, y } = placeRows(rows, headerTop + HEAD_H + 18);
  const height = y - GAP + 20;

  const at = (row: number, x: number): Box | undefined =>
    placed[row].find((b) => b.x === x);
  const arrows: Arrow[] = [];
  const chain = (boxes: (Box | undefined)[]) => {
    for (let i = 0; i < boxes.length - 1; i++) {
      const a = boxes[i];
      const b = boxes[i + 1];
      if (a && b) {
        arrows.push([
          [midX(a), a.y + a.h],
          [midX(b), b.y],
        ]);
      }
    }
  };
  chain([at(0, MAIN_X), at(1, MAIN_X), at(2, MAIN_X), at(3, MAIN_X), at(4, MAIN_X)]);
  chain([at(0, OTH_X), at(2, OTH_X), at(3, OTH_X)]);
  const sidePairs: [number, number, number][] = [
    [0, MAIN_X + MAIN_W, S1_X],
    [1, MAIN_X + MAIN_W, S1_X],
    [2, MAIN_X + MAIN_W, S1_X],
    [3, MAIN_X + MAIN_W, S1_X],
    [2, OTH_X + OTH_W, S2_X],
    [3, OTH_X + OTH_W, S2_X],
  ];
  for (const [row, fromX, toX] of sidePairs) {
    const side = placed[row].find((b) => b.x === toX);
    if (side) {
      arrows.push([
        [fromX, side.y + side.h / 2],
        [toX, side.y + side.h / 2],
      ]);
    }
  }
  // The other methods arm merges into the shared included box.
  const othAssessed = at(3, OTH_X);
  const included = at(4, MAIN_X);
  if (othAssessed && included) {
    const incMidY = included.y + included.h / 2;
    arrows.push([
      [midX(othAssessed), othAssessed.y + othAssessed.h],
      [midX(othAssessed), incMidY],
      [included.x + included.w, incMidY],
    ]);
  }

  const identBottom = Math.max(...placed[0].map((b) => b.y + b.h));
  const bands = stageBands(
    headerTop,
    identBottom,
    (at(4, MAIN_X)?.y ?? height) - GAP / 2,
    height - 20
  );

  return {
    boxes: [...headers, ...bands, ...placed.flat()],
    arrows,
    width,
    height,
  };
}

function PrismaDiagram({
  counts,
  svgRef,
}: {
  counts: Counts;
  svgRef: React.RefObject<SVGSVGElement | null>;
}) {
  const { boxes, arrows, width, height } = layoutDiagram(counts);
  return (
    <svg
      ref={svgRef}
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`0 0 ${width} ${height}`}
      width="100%"
      style={{ maxWidth: width, background: "#ffffff" }}
    >
      <defs>
        <marker
          id="arrow"
          markerWidth="8"
          markerHeight="8"
          refX="7"
          refY="4"
          orient="auto"
        >
          <path d="M0,0 L8,4 L0,8 z" fill="#3f3f46" />
        </marker>
      </defs>
      {arrows.map((pts, i) => (
        <path
          key={i}
          d={pts
            .map(([x, y], pi) => `${pi === 0 ? "M" : "L"} ${x} ${y}`)
            .join(" ")}
          stroke="#3f3f46"
          strokeWidth="1.4"
          fill="none"
          markerEnd="url(#arrow)"
        />
      ))}
      {boxes.map((b, i) => (
        <g key={i}>
          <rect
            x={b.x}
            y={b.y}
            width={b.w}
            height={b.h}
            rx="6"
            fill={b.header ? "#f4f4f5" : "#fafafa"}
            stroke={b.header ? "none" : "#3f3f46"}
            strokeWidth="1.2"
          />
          {b.vertical ? (
            <text
              x={b.x + b.w / 2}
              y={b.y + b.h / 2}
              transform={`rotate(-90 ${b.x + b.w / 2} ${b.y + b.h / 2})`}
              textAnchor="middle"
              dominantBaseline="central"
              fontWeight={600}
              fontFamily="Helvetica, Arial, sans-serif"
              fontSize="12.5"
              fill="#18181b"
            >
              {b.lines[0]}
            </text>
          ) : (
            b.lines.map((line, li) => (
              <text
                key={li}
                x={b.header ? b.x + b.w / 2 : b.x + 10}
                y={
                  b.header
                    ? b.y + b.h / 2 + 4.5
                    : b.y + 10 + (li + 1) * 16 - 4
                }
                textAnchor={b.header ? "middle" : "start"}
                fontWeight={b.header ? 600 : 400}
                fontFamily="Helvetica, Arial, sans-serif"
                fontSize="12.5"
                fill="#18181b"
              >
                {line}
              </text>
            ))
          )}
        </g>
      ))}
    </svg>
  );
}

// ----------------------------------------------------------------------
// Page component
// ----------------------------------------------------------------------

export default function PrismaClient({ project }: { project: Project }) {
  const [data, setData] = useState<Data | null>(null);
  const [counts, setCounts] = useState<Counts | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const svgRef = useRef<SVGSVGElement | null>(null);

  const load = useCallback(async () => {
    const supabase = createClient();
    try {
      const [records, decisions, reasons, databases, batches, members] =
        await Promise.all([
          fetchPaged<RecordRow>((f, t) =>
            supabase.from("records").select("*").eq("project_id", project.id).order("created_at").range(f, t)
          ),
          fetchPaged<ScreeningDecision>((f, t) =>
            supabase.from("screening_decisions").select("*").eq("project_id", project.id).order("decided_at").range(f, t)
          ),
          fetchPaged<ExclusionReason>((f, t) =>
            supabase.from("exclusion_reasons").select("*").eq("project_id", project.id).order("position").range(f, t)
          ),
          fetchPaged<ProjectDatabase>((f, t) =>
            supabase.from("project_databases").select("*").eq("project_id", project.id).order("position").range(f, t)
          ),
          fetchPaged<ImportBatch>((f, t) =>
            supabase.from("import_batches").select("*").eq("project_id", project.id).order("created_at").range(f, t)
          ),
          fetchPaged<{ user_id: string; profiles: Profile | Profile[] | null }>(
            (f, t) =>
              supabase
                .from("project_members")
                .select("user_id, profiles(id, email, display_name)")
                .eq("project_id", project.id)
                .range(f, t)
          ),
        ]);
      const profiles = new Map<string, Profile>();
      members.forEach((m) => {
        const p = Array.isArray(m.profiles) ? m.profiles[0] : m.profiles;
        if (p) profiles.set(m.user_id, p);
      });
      const resolutions = await fetchResolutions(supabase, project.id);
      // Models the AI prescreen used, for the written summary's
      // automation sentence (empty when the prescreen never ran or the
      // table predates migration 0018).
      const prescreenModels = new Set<string>();
      {
        const { data: ex } = await supabase
          .from("prescreen_extractions")
          .select("model")
          .eq("project_id", project.id)
          .range(0, 999);
        (ex ?? []).forEach((r) => prescreenModels.add(r.model));
      }
      const d: Data = {
        records,
        decisions,
        resolutions,
        requiredTa: requiredFor(project, "title_abstract"),
        requiredFt: requiredFor(project, "full_text"),
        prescreenModels: [...prescreenModels].sort(),
        reasons,
        databases,
        batches,
        profiles,
      };
      setData(d);
      setCounts(computeCounts(d));
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

  const stamp = new Date().toISOString().slice(0, 10);
  const base = `${slugify(project.name)}-${stamp}`;

  async function exportBackup() {
    if (!data) return;
    // Concept matrix tables are fetched on demand; before migration 0009
    // they do not exist and the backup simply omits them.
    const supabase = createClient();
    const fetchAll = async (table: string) => {
      try {
        return await fetchPaged<Record<string, unknown>>((f, t) =>
          supabase.from(table).select("*").eq("project_id", project.id).range(f, t)
        );
      } catch {
        return [];
      }
    };
    const [concepts, conceptTags, conceptExcerpts, snowballLinks, inclusionCodes] =
      await Promise.all([
        fetchAll("concepts"),
        fetchAll("concept_tags"),
        fetchAll("concept_excerpts"),
        fetchAll("snowball_links"),
        fetchAll("inclusion_codes"),
      ]);
    downloadFile(
      `${base}-backup.json`,
      JSON.stringify(
        {
          exported_at: new Date().toISOString(),
          project,
          databases: data.databases,
          batches: data.batches,
          records: data.records,
          decisions: data.decisions,
          reasons: data.reasons,
          members: [...data.profiles.values()],
          concepts,
          concept_tags: conceptTags,
          concept_excerpts: conceptExcerpts,
          snowball_links: snowballLinks,
          inclusion_codes: inclusionCodes,
        },
        null,
        2
      ),
      "application/json"
    );
  }

  function exportRis(which: "ta" | "ft") {
    if (!data || !counts) return;
    const ids = which === "ta" ? counts.taRecordIds : counts.ftRecordIds;
    const recs = data.records.filter((r) => ids.has(r.id));
    downloadFile(
      `${base}-included-${which === "ta" ? "title-abstract" : "full-text"}.ris`,
      buildRis(recs),
      "application/x-research-info-systems"
    );
  }

  function exportRecordsCsv() {
    if (!data || !counts) return;
    const taMap = decisionsByRecord(data.decisions, "title_abstract");
    const ftMap = decisionsByRecord(data.decisions, "full_text");
    const reasonLabel = new Map(data.reasons.map((r) => [r.id, r.label]));
    const rows = data.records.map((r) => {
      const ta = settledOutcome(
        taMap.get(r.id) ?? [],
        data.resolutions.get(resKey("title_abstract", r.id)),
        data.requiredTa
      );
      const ft = counts.taRecordIds.has(r.id)
        ? settledOutcome(
            ftMap.get(r.id) ?? [],
            data.resolutions.get(resKey("full_text", r.id)),
            data.requiredFt
          )
        : "";
      const taReasons = (taMap.get(r.id) ?? [])
        .filter((d) => d.reason_id)
        .map((d) => reasonLabel.get(d.reason_id!) ?? "")
        .join("; ");
      return [
        r.title,
        r.authors,
        r.year,
        r.venue,
        r.doi,
        r.url,
        r.source_label,
        r.status,
        ta,
        taReasons,
        ft,
      ];
    });
    downloadFile(
      `${base}-records.csv`,
      buildCsv(
        [
          "title", "authors", "year", "venue", "doi", "url", "source",
          "status", "ta_outcome", "ta_reasons", "ft_outcome",
        ],
        rows
      ),
      "text/csv"
    );
  }

  async function exportLogCsv() {
    if (!data) return;
    const reasonLabel = new Map(data.reasons.map((r) => [r.id, r.label]));
    const recById = new Map(data.records.map((r) => [r.id, r]));
    // Inclusion code labels (empty before migration 0012).
    const supabase = createClient();
    const { data: codes } = await supabase
      .from("inclusion_codes")
      .select("id, label")
      .eq("project_id", project.id);
    const codeLabel = new Map(
      ((codes ?? []) as { id: string; label: string }[]).map((c) => [c.id, c.label])
    );
    // Deliberately streamlined: one row per screening event, second
    // precision timestamps, display names over emails, one shared
    // reason-or-code column, and titles capped at 100 characters (the
    // DOI identifies the record unambiguously where one exists). A
    // 200 record dual screened review stays well under 200 KB.
    const nameOf = (uid: string) => {
      const p = data.profiles.get(uid);
      return p?.display_name || p?.email || "member";
    };
    const t = (iso: string) =>
      iso.replace(/\.\d+/, "").replace(/\+00:00$/, "Z");
    const cap = (s?: string | null) => {
      const x = s ?? "";
      return x.length > 100 ? x.slice(0, 97) + "..." : x;
    };
    const stageOf = (s: string) =>
      s === "full_text" ? "full text" : "title/abstract";
    const detailOf = (
      decision: string,
      reasonId: string | null,
      codeId?: string | null
    ) =>
      decision === "exclude"
        ? reasonId
          ? (reasonLabel.get(reasonId) ?? "removed reason")
          : ""
        : codeId
          ? (codeLabel.get(codeId) ?? "removed code")
          : "";
    type Row = [string, string, string, string, string, string, string, string];
    // Opinions and conflict resolutions interleave chronologically, so
    // the file reads as what happened, in order, including who settled
    // each disagreement and how.
    const events: Row[] = [
      ...data.decisions.map((d): Row => {
        const rec = recById.get(d.record_id);
        return [
          t(d.decided_at),
          stageOf(d.stage),
          "opinion",
          d.decision,
          detailOf(d.decision, d.reason_id, d.inclusion_code_id),
          nameOf(d.decided_by),
          rec?.doi ?? "",
          cap(rec?.title),
        ];
      }),
      ...[...data.resolutions.values()].map((r): Row => {
        const rec = recById.get(r.record_id);
        return [
          t(r.resolved_at),
          stageOf(r.stage),
          "conflict resolution",
          r.decision,
          detailOf(r.decision, r.reason_id, r.inclusion_code_id),
          nameOf(r.resolved_by),
          rec?.doi ?? "",
          cap(rec?.title),
        ];
      }),
    ].sort((a, b) => a[0].localeCompare(b[0]));
    downloadFile(
      `${base}-screening-log.csv`,
      buildCsv(
        [
          "time",
          "stage",
          "event",
          "decision",
          "reason_or_code",
          "reviewer",
          "doi",
          "title",
        ],
        events
      ),
      "text/csv"
    );
  }

  /**
   * The diagram as editable PowerPoint shapes: every box is a real
   * text box and every arrow a line, so users can move elements and
   * edit text, then use it directly or paste into Word.
   */
  async function exportPptx() {
    if (!counts) return;
    const { boxes, arrows, width, height } = layoutDiagram(counts);
    const pptxgen = (await import("pptxgenjs")).default;
    const pres = new pptxgen();
    pres.defineLayout({ name: "PRISMA", width: 13.33, height: 7.5 });
    pres.layout = "PRISMA";
    const slide = pres.addSlide();
    const margin = 0.25;
    const scale = Math.min(
      (13.33 - margin * 2) / (width / 96),
      (7.5 - margin * 2) / (height / 96)
    );
    const X = (px: number) => margin + (px / 96) * scale;
    const Y = (px: number) => margin + (px / 96) * scale;
    const S = (px: number) => (px / 96) * scale;
    const fontSize = Math.max(6, Math.round(12.5 * 0.75 * scale * 10) / 10);

    for (const pts of arrows) {
      for (let i = 0; i < pts.length - 1; i++) {
        const [x1, y1] = pts[i];
        const [x2, y2] = pts[i + 1];
        slide.addShape("line", {
          x: X(Math.min(x1, x2)),
          y: Y(Math.min(y1, y2)),
          w: S(Math.abs(x2 - x1)),
          h: S(Math.abs(y2 - y1)),
          flipH: x2 < x1,
          flipV: y2 < y1,
          line: {
            color: "3F3F46",
            width: 1,
            // Arrowhead only on the final segment of a polyline.
            endArrowType: i === pts.length - 2 ? "triangle" : "none",
          },
        });
      }
    }
    for (const b of boxes) {
      if (b.vertical) {
        // Rotated stage band: swap width and height around the center.
        const cx = X(b.x) + S(b.w) / 2;
        const cy = Y(b.y) + S(b.h) / 2;
        slide.addText(b.lines[0], {
          x: cx - S(b.h) / 2,
          y: cy - S(b.w) / 2,
          w: S(b.h),
          h: S(b.w),
          rotate: 270,
          shape: "rect",
          fill: { color: "F4F4F5" },
          line: { type: "none" },
          fontSize,
          bold: true,
          color: "18181B",
          align: "center",
          valign: "middle",
          fontFace: "Helvetica",
        });
        continue;
      }
      slide.addText(b.lines.join("\n"), {
        x: X(b.x),
        y: Y(b.y),
        w: S(b.w),
        h: S(b.h),
        shape: "rect",
        fill: { color: b.header ? "F4F4F5" : "FAFAFA" },
        line: b.header ? { type: "none" } : { color: "3F3F46", width: 1 },
        fontSize,
        bold: Boolean(b.header),
        color: "18181B",
        align: b.header ? "center" : "left",
        valign: b.header ? "middle" : "top",
        fontFace: "Helvetica",
        margin: 3,
      });
    }
    await pres.writeFile({ fileName: `${base}-prisma-diagram.pptx` });
  }

  function exportSvg() {
    const svg = svgRef.current;
    if (!svg) return;
    downloadFile(`${base}-prisma.svg`, svg.outerHTML, "image/svg+xml");
  }

  function exportPng() {
    const svg = svgRef.current;
    if (!svg) return;
    const xml = new XMLSerializer().serializeToString(svg);
    const img = new Image();
    const scale = 2;
    img.onload = () => {
      const vb = svg.viewBox.baseVal;
      const canvas = document.createElement("canvas");
      canvas.width = vb.width * scale;
      canvas.height = vb.height * scale;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      canvas.toBlob((blob) => {
        if (!blob) return;
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${base}-prisma.png`;
        a.click();
        URL.revokeObjectURL(url);
      }, "image/png");
    };
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(xml)}`;
  }

  const summary =
    counts && data
      ? buildPrismaSummary({
          searchConfig: project.search_config,
          databases: data.databases,
          counts,
          memberCount: data.profiles.size,
          asOf: formatLongDate(stamp) ?? stamp,
          requiredTa: data.requiredTa,
          requiredFt: data.requiredFt,
          resolutionsCount: data.resolutions.size,
          prescreenModels: data.prescreenModels,
        })
      : null;

  async function copySummary() {
    if (!summary) return;
    try {
      await navigator.clipboard.writeText(summary.join("\n\n"));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard unavailable (e.g. insecure context); the text on the
      // page stays selectable, so there is nothing more to do here.
    }
  }

    
  return (
    <main className="mx-auto w-full max-w-4xl flex-1 px-6 py-8">
      <div className="mb-1 flex items-center justify-between gap-3">
        <h1 className="font-serif text-2xl font-semibold text-zinc-900 dark:text-zinc-50">
          Report
        </h1>
        <button
          onClick={() => window.print()}
          className={`${exportBtn} print:hidden`}
          title="Prints the diagram, summary, source table, and methodology as a clean document; use the print dialog's Save as PDF for a file"
        >
          Print / save as PDF
        </button>
      </div>
      <p className="mb-6 text-sm text-zinc-600 print:hidden dark:text-zinc-400">
        Everything the review produces, in one place: the PRISMA 2020 flow
        diagram, the written methods summary, the exports, and a description
        of the methodology behind this tool for citing and reporting. Every
        number is computed live from the records and decisions; nothing is
        entered by hand.
      </p>

      {error && (
        <p className="mb-4 rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
          {error}
        </p>
      )}

      {!counts || !data ? (
        <p className="text-zinc-600 dark:text-zinc-400">Computing...</p>
      ) : (
        <>
          {(counts.taUndecided > 0 || counts.taConflicts > 0 || counts.ftUndecided > 0) && (
            <p className="mb-4 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200">
              Screening is not finished: {counts.taUndecided} undecided and{" "}
              {counts.taConflicts} conflicting record(s) at title/abstract,{" "}
              {counts.ftUndecided} awaiting full text. The diagram is a live
              snapshot until those reach zero.
            </p>
          )}

          <section className={`${card} mb-6`}>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="font-serif text-lg font-semibold text-zinc-900 dark:text-zinc-50">
                Flow diagram
              </h2>
              <div className="flex flex-wrap gap-2 print:hidden">
                <button
                  onClick={exportPptx}
                  className={exportBtn}
                  title="Every box and arrow as an editable PowerPoint shape: move elements, edit text, then use it directly or paste into Word"
                >
                  Editable PowerPoint
                </button>
                <button onClick={exportSvg} className={exportBtn}>
                  Download SVG
                </button>
                <button onClick={exportPng} className={exportBtn}>
                  Download PNG
                </button>
              </div>
            </div>
            <div className="overflow-x-auto rounded-lg border border-zinc-100 print:overflow-visible print:border-0 dark:border-zinc-800">
              <PrismaDiagram counts={counts} svgRef={svgRef} />
            </div>
          </section>

          {summary && (
            <section className={`${card} mb-6`}>
              <div className="mb-1 flex items-center justify-between gap-3">
                <h2 className="font-serif text-lg font-semibold text-zinc-900 dark:text-zinc-50">
                  Written summary
                </h2>
                <button
                  onClick={copySummary}
                  className={`${exportBtn} print:hidden`}
                  title="Copy the whole summary to the clipboard"
                >
                  {copied ? "Copied" : "Copy text"}
                </button>
              </div>
              <p className="mb-4 text-sm text-zinc-600 print:hidden dark:text-zinc-400">
                A methods section draft in PRISMA 2020 reporting style, built
                from the same live data as the diagram. Paste it into your
                paper as a starting point and fill in anything shown in
                [brackets].
              </p>
              <div className="flex flex-col gap-3">
                {summary.map((p, i) => (
                  <p
                    key={i}
                    className="font-serif text-[15px] leading-7 text-zinc-800 dark:text-zinc-200"
                  >
                    {p}
                  </p>
                ))}
              </div>
            </section>
          )}

          <section className={`${card} mb-6`}>
            <h2 className="mb-3 font-serif text-lg font-semibold text-zinc-900 dark:text-zinc-50">
              Identification per source
            </h2>
            <table className="w-full text-sm tabular-nums">
              <thead>
                <tr className="text-left text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                  <th className="pb-2">Source</th>
                  <th className="pb-2 text-right">Hits reported</th>
                  <th className="pb-2 text-right">Imported</th>
                </tr>
              </thead>
              <tbody>
                {counts.perSource.map((s) => (
                  <tr key={s.name} className="border-t border-zinc-100 dark:border-zinc-800">
                    <td className="py-2 text-zinc-800 dark:text-zinc-200">{s.name}</td>
                    <td className="py-2 text-right text-zinc-500">{s.rawHits ?? ""}</td>
                    <td className="py-2 text-right text-zinc-800 dark:text-zinc-200">{s.imported}</td>
                  </tr>
                ))}
                <tr className="border-t border-zinc-200 font-medium dark:border-zinc-700">
                  <td className="py-2 text-zinc-900 dark:text-zinc-50">Total</td>
                  <td />
                  <td className="py-2 text-right text-zinc-900 dark:text-zinc-50">
                    {counts.identified}
                  </td>
                </tr>
              </tbody>
            </table>
          </section>

          <section className={`${card} print:hidden`}>
            <h2 className="mb-1 font-serif text-lg font-semibold text-zinc-900 dark:text-zinc-50">
              Exports
            </h2>
            <p className="mb-4 text-sm text-zinc-600 dark:text-zinc-400">
              The RIS files import directly into Zotero or Mendeley for full
              text reading and citing. The backup JSON contains the complete
              project; download one after every serious screening session.
              The concept matrix and excerpt CSVs live beside the matrix on
              the Synthesize page.
            </p>
            <div className="flex flex-wrap gap-2">
              <button onClick={exportBackup} className={exportBtn}>
                Full backup (JSON)
              </button>
              <button
                onClick={() => exportRis("ta")}
                disabled={counts.taIncluded === 0}
                className={exportBtn}
              >
                Included after title/abstract (RIS, {counts.taIncluded})
              </button>
              <button
                onClick={() => exportRis("ft")}
                disabled={counts.ftIncluded === 0}
                className={exportBtn}
              >
                Included after full text (RIS, {counts.ftIncluded})
              </button>
              <button onClick={exportRecordsCsv} className={exportBtn}>
                All records (CSV)
              </button>
              <button onClick={exportLogCsv} className={exportBtn}>
                Screening log (CSV)
              </button>
            </div>
          </section>

          <section className={`${card} mt-6`}>
            <h2 className="mb-1 font-serif text-lg font-semibold text-zinc-900 dark:text-zinc-50">
              How SimpleSLR works, for your methods section
            </h2>
            <p className="mb-4 text-sm text-zinc-600 dark:text-zinc-400">
              The procedures below describe what this tool actually does, so
              reviewers of your manuscript can verify the process. Cite
              SimpleSLR with the version date and reproduce whichever
              descriptions apply to your review.
            </p>
            <div className="flex flex-col gap-3 font-serif text-[14.5px] leading-7 text-zinc-700 dark:text-zinc-300">
              <div>
                <h3 className="font-serif font-semibold text-zinc-900 dark:text-zinc-50">
                  Identification and deduplication
                </h3>
                <p>
                  Records enter from database exports (RIS, BibTeX, CSV),
                  citation searching, or manual entry, each carrying its
                  source. Duplicates are detected by DOI match or by
                  normalized title match corroborated by a shared author or
                  matching year, are reviewed by the team, and are merged
                  toward a single kept record.
                </p>
              </div>
              <div>
                <h3 className="font-serif font-semibold text-zinc-900 dark:text-zinc-50">
                  Screening
                </h3>
                <p>
                  Two stages (title/abstract, then full text) against the
                  recorded inclusion criteria and the exclusion reasons
                  list. With independent screening on, each record requires
                  the configured number of independent opinions before a
                  team outcome exists; reviewers cannot see one another&apos;s
                  decisions until then, and disagreements are resolved after
                  discussion, with the resolution logged. Every opinion and
                  resolution is timestamped in the exportable screening log.
                </p>
              </div>
              <div>
                <h3 className="font-serif font-semibold text-zinc-900 dark:text-zinc-50">
                  Automated prescreening (optional)
                </h3>
                <p>
                  When enabled, each unscreened title and abstract is judged
                  by five procedurally distinct prompts on fixed, prescribed
                  language models at temperature zero. A record is removed
                  only when all five votes conclude exclude, cite the same
                  criterion from the project&apos;s own list, and quote verbatim
                  evidence from the record&apos;s text, and a final adversarial
                  check finds no plausible eligible reading. Errors and
                  ambiguity default to human screening; removals are counted
                  on the PRISMA line for automation tools, remain visible
                  with their full vote record, and are restorable. A
                  validation mode replays the pipeline on human-screened
                  records to measure agreement before live use.
                </p>
              </div>
              <div>
                <h3 className="font-serif font-semibold text-zinc-900 dark:text-zinc-50">
                  Citation searching
                </h3>
                <p>
                  Backward and forward snowballing from the included set
                  (Webster and Watson), via OpenAlex or database exports,
                  with per-seed provenance recorded. Papers already in the
                  corpus are consolidated onto their existing record rather
                  than duplicated, and identification counts follow the
                  PRISMA 2020 two-arm layout.
                </p>
              </div>
              <div>
                <h3 className="font-serif font-semibold text-zinc-900 dark:text-zinc-50">
                  Synthesis
                </h3>
                <p>
                  Concept-centric coding in the Webster and Watson style:
                  passages are anchored verbatim to the source PDF, and the
                  concept matrix is built from those anchored excerpts.
                  Optional AI-suggested passages are quarantined until a
                  researcher individually accepts or rejects each one, and
                  suggested quotes are verified verbatim against the
                  extracted text before they can appear.
                </p>
              </div>
              <div>
                <h3 className="font-serif font-semibold text-zinc-900 dark:text-zinc-50">
                  Reporting
                </h3>
                <p>
                  The PRISMA 2020 flow diagram and the written summary above
                  are computed from the recorded decisions, count only
                  settled team outcomes, and report optional features only
                  when they were actually used.
                </p>
              </div>
              <p className="font-sans text-xs text-zinc-500 print:hidden dark:text-zinc-400">
                Questions about any of these procedures:{" "}
                <a
                  href="mailto:support@simpleslr.de"
                  className="underline underline-offset-2"
                >
                  support@simpleslr.de
                </a>
              </p>
            </div>
          </section>
        </>
      )}
    </main>
  );
}
