"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { buildCsv, buildRis, downloadFile, slugify } from "@/lib/export";
import { decisionsByRecord, outcomeOf } from "@/lib/outcomes";
import type {
  ExclusionReason,
  ImportBatch,
  Profile,
  Project,
  ProjectDatabase,
  RecordRow,
  ScreeningDecision,
} from "@/lib/types";

type Data = {
  records: RecordRow[];
  decisions: ScreeningDecision[];
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
  const active = d.records.filter((r) => r.status === "active");
  const duplicates = d.records.length - active.length;

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
    if (r.status !== "active") {
      arm.duplicates++;
      continue;
    }
    arm.screened++;
    const o = outcomeOf(taMap.get(r.id) ?? []);
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
    const o = outcomeOf(decs);
    if (o === "excluded") {
      ftExcluded++;
      arm.ftExcluded++;
      const withReason = decs.find(
        (x) => x.decision === "exclude" && x.reason_id
      );
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
    screened: active.length,
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
};

type Diagram = { boxes: Box[]; arrows: string[]; width: number; height: number };

const LINE = 16;
const PAD = 10;
const GAP = 26;

function mkBox(x: number, w: number, lines: string[]): Omit<Box, "y"> {
  return { x, w, h: lines.length * LINE + PAD * 2, lines };
}

function reasonLines(arm: ArmCounts): string[] {
  const lines = arm.ftExcludedByReason
    .slice(0, 8)
    .map((r) => `${r.label} (n = ${r.count})`);
  return lines.length ? lines : ["(no full text exclusions yet)"];
}

function sourceLines(c: Counts): string[] {
  const dbSources = c.perSource.filter((s) => !s.snowball);
  const lines = dbSources.slice(0, 6).map((s) => `${s.name} (n = ${s.imported})`);
  if (dbSources.length > 6) lines.push("and more sources");
  return lines;
}

function layoutDiagram(c: Counts): Diagram {
  return c.other.identified > 0 ? layoutTwoArms(c) : layoutSingleArm(c);
}

/** Classic single column layout, used while no snowballing has happened. */
function layoutSingleArm(c: Counts): Diagram {
  const MAIN_X = 30;
  const MAIN_W = 330;
  const SIDE_X = 410;
  const SIDE_W = 300;

  const identify = mkBox(MAIN_X, MAIN_W, [
    "Records identified from databases",
    `(n = ${c.identified})`,
    ...sourceLines(c),
  ]);
  const dupBox = mkBox(SIDE_X, SIDE_W, [
    "Duplicate records removed",
    `(n = ${c.duplicates})`,
  ]);
  const screened = mkBox(MAIN_X, MAIN_W, [`Records screened (n = ${c.screened})`]);
  const taExc = mkBox(SIDE_X, SIDE_W, [
    "Records excluded at title/abstract",
    `(n = ${c.taExcluded})`,
  ]);
  const sought = mkBox(MAIN_X, MAIN_W, [
    "Reports sought for retrieval",
    `(n = ${c.taIncluded})`,
  ]);
  const notRet = mkBox(SIDE_X, SIDE_W, [
    "Reports not retrieved",
    `(n = ${c.notRetrieved})`,
  ]);
  const assessed = mkBox(MAIN_X, MAIN_W, [
    "Reports assessed for eligibility",
    `(n = ${c.assessed})`,
  ]);
  const ftExc = mkBox(SIDE_X, SIDE_W, [
    `Reports excluded (n = ${c.ftExcluded}):`,
    ...reasonLines(c.db),
  ]);
  const included = mkBox(MAIN_X, MAIN_W, [
    "Studies included in review",
    `(n = ${c.ftIncluded})`,
  ]);

  let y = 20;
  const identifyB: Box = { ...identify, y };
  y += identify.h + GAP;
  const screenedB: Box = { ...screened, y };
  y += screened.h + GAP;
  const soughtB: Box = { ...sought, y };
  y += sought.h + GAP;
  const assessedB: Box = { ...assessed, y };
  y += assessed.h + GAP;
  const includedB: Box = { ...included, y };
  const height = y + included.h + 20;

  const dupB: Box = { ...dupBox, y: identifyB.y + (identifyB.h - dupBox.h) / 2 };
  const taExcB: Box = { ...taExc, y: screenedB.y + (screenedB.h - taExc.h) / 2 };
  const notRetB: Box = { ...notRet, y: soughtB.y + (soughtB.h - notRet.h) / 2 };
  const ftExcB: Box = { ...ftExc, y: assessedB.y + (assessedB.h - ftExc.h) / 2 };

  const midMain = MAIN_X + MAIN_W / 2;
  const arrows = [
    `M ${midMain} ${identifyB.y + identifyB.h} L ${midMain} ${screenedB.y}`,
    `M ${midMain} ${screenedB.y + screenedB.h} L ${midMain} ${soughtB.y}`,
    `M ${midMain} ${soughtB.y + soughtB.h} L ${midMain} ${assessedB.y}`,
    `M ${midMain} ${assessedB.y + assessedB.h} L ${midMain} ${includedB.y}`,
    `M ${MAIN_X + MAIN_W} ${dupB.y + dupB.h / 2} L ${SIDE_X} ${dupB.y + dupB.h / 2}`,
    `M ${MAIN_X + MAIN_W} ${taExcB.y + taExcB.h / 2} L ${SIDE_X} ${taExcB.y + taExcB.h / 2}`,
    `M ${MAIN_X + MAIN_W} ${notRetB.y + notRetB.h / 2} L ${SIDE_X} ${notRetB.y + notRetB.h / 2}`,
    `M ${MAIN_X + MAIN_W} ${ftExcB.y + ftExcB.h / 2} L ${SIDE_X} ${ftExcB.y + ftExcB.h / 2}`,
  ];

  return {
    boxes: [
      identifyB,
      dupB,
      screenedB,
      taExcB,
      soughtB,
      notRetB,
      assessedB,
      ftExcB,
      includedB,
    ],
    arrows,
    width: 740,
    height,
  };
}

/**
 * PRISMA 2020 two column layout: identification via databases on the
 * left, via other methods (snowballing) on the right, meeting in the
 * shared "Studies included" box at the bottom. The right arm carries a
 * "Records screened" box, an addition the guideline permits, because
 * SimpleSLR formally screens snowball records at title/abstract.
 */
function layoutTwoArms(c: Counts): Diagram {
  const MAIN_X = 20;
  const MAIN_W = 300;
  const S1_X = 336;
  const S1_W = 240;
  const OTH_X = 612;
  const OTH_W = 300;
  const S2_X = 928;
  const S2_W = 240;
  const width = S2_X + S2_W + 20;

  const dirLines: string[] = [];
  if (c.other.backward > 0) dirLines.push(`Backward (n = ${c.other.backward})`);
  if (c.other.forward > 0) dirLines.push(`Forward (n = ${c.other.forward})`);

  const rows: {
    main: Omit<Box, "y">;
    oth: Omit<Box, "y">;
    side1: Omit<Box, "y"> | null;
    side2: Omit<Box, "y"> | null;
  }[] = [
    {
      main: mkBox(MAIN_X, MAIN_W, [
        "Records identified from databases",
        `(n = ${c.db.identified})`,
        ...sourceLines(c),
      ]),
      oth: mkBox(OTH_X, OTH_W, [
        "Records identified via snowballing",
        `(n = ${c.other.identified})`,
        ...dirLines,
      ]),
      side1: mkBox(S1_X, S1_W, [
        "Duplicate records removed",
        `(n = ${c.db.duplicates})`,
      ]),
      side2:
        c.other.duplicates > 0
          ? mkBox(S2_X, S2_W, [
              "Duplicate records removed",
              `(n = ${c.other.duplicates})`,
            ])
          : null,
    },
    {
      main: mkBox(MAIN_X, MAIN_W, [`Records screened (n = ${c.db.screened})`]),
      oth: mkBox(OTH_X, OTH_W, [`Records screened (n = ${c.other.screened})`]),
      side1: mkBox(S1_X, S1_W, [
        "Records excluded at title/abstract",
        `(n = ${c.db.taExcluded})`,
      ]),
      side2: mkBox(S2_X, S2_W, [
        "Records excluded at title/abstract",
        `(n = ${c.other.taExcluded})`,
      ]),
    },
    {
      main: mkBox(MAIN_X, MAIN_W, [
        "Reports sought for retrieval",
        `(n = ${c.db.sought})`,
      ]),
      oth: mkBox(OTH_X, OTH_W, [
        "Reports sought for retrieval",
        `(n = ${c.other.sought})`,
      ]),
      side1: mkBox(S1_X, S1_W, [
        "Reports not retrieved",
        `(n = ${c.db.notRetrieved})`,
      ]),
      side2: mkBox(S2_X, S2_W, [
        "Reports not retrieved",
        `(n = ${c.other.notRetrieved})`,
      ]),
    },
    {
      main: mkBox(MAIN_X, MAIN_W, [
        "Reports assessed for eligibility",
        `(n = ${c.db.assessed})`,
      ]),
      oth: mkBox(OTH_X, OTH_W, [
        "Reports assessed for eligibility",
        `(n = ${c.other.assessed})`,
      ]),
      side1: mkBox(S1_X, S1_W, [
        `Reports excluded (n = ${c.db.ftExcluded}):`,
        ...reasonLines(c.db),
      ]),
      side2: mkBox(S2_X, S2_W, [
        `Reports excluded (n = ${c.other.ftExcluded}):`,
        ...reasonLines(c.other),
      ]),
    },
  ];

  const boxes: Box[] = [];
  const arrows: string[] = [];
  const HEAD_H = 30;
  let y = 16;
  boxes.push({
    x: MAIN_X,
    y,
    w: S1_X + S1_W - MAIN_X,
    h: HEAD_H,
    lines: ["Identification of studies via databases"],
    header: true,
  });
  boxes.push({
    x: OTH_X,
    y,
    w: S2_X + S2_W - OTH_X,
    h: HEAD_H,
    lines: ["Identification of studies via snowballing"],
    header: true,
  });
  y += HEAD_H + 18;

  const mainMid = MAIN_X + MAIN_W / 2;
  const othMid = OTH_X + OTH_W / 2;
  const placed: { main: Box; oth: Box }[] = [];
  for (const row of rows) {
    const rowH = Math.max(
      row.main.h,
      row.oth.h,
      row.side1?.h ?? 0,
      row.side2?.h ?? 0
    );
    const center = (b: Omit<Box, "y">): Box => ({
      ...b,
      y: y + (rowH - b.h) / 2,
    });
    const mainB = center(row.main);
    const othB = center(row.oth);
    boxes.push(mainB, othB);
    if (row.side1) {
      const s = center(row.side1);
      boxes.push(s);
      arrows.push(
        `M ${MAIN_X + MAIN_W} ${s.y + s.h / 2} L ${S1_X} ${s.y + s.h / 2}`
      );
    }
    if (row.side2) {
      const s = center(row.side2);
      boxes.push(s);
      arrows.push(
        `M ${OTH_X + OTH_W} ${s.y + s.h / 2} L ${S2_X} ${s.y + s.h / 2}`
      );
    }
    placed.push({ main: mainB, oth: othB });
    y += rowH + GAP;
  }
  for (let i = 0; i < placed.length - 1; i++) {
    arrows.push(
      `M ${mainMid} ${placed[i].main.y + placed[i].main.h} L ${mainMid} ${placed[i + 1].main.y}`
    );
    arrows.push(
      `M ${othMid} ${placed[i].oth.y + placed[i].oth.h} L ${othMid} ${placed[i + 1].oth.y}`
    );
  }

  const included = mkBox(MAIN_X, MAIN_W, [
    "Studies included in review",
    `(n = ${c.db.ftIncluded + c.other.ftIncluded})`,
    `Via databases (n = ${c.db.ftIncluded})`,
    `Via snowballing (n = ${c.other.ftIncluded})`,
  ]);
  const includedB: Box = { ...included, y };
  boxes.push(includedB);
  const last = placed[placed.length - 1];
  arrows.push(
    `M ${mainMid} ${last.main.y + last.main.h} L ${mainMid} ${includedB.y}`
  );
  const incMidY = includedB.y + includedB.h / 2;
  arrows.push(
    `M ${othMid} ${last.oth.y + last.oth.h} L ${othMid} ${incMidY} L ${MAIN_X + MAIN_W} ${incMidY}`
  );

  return { boxes, arrows, width, height: y + included.h + 20 };
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
      {arrows.map((d, i) => (
        <path
          key={i}
          d={d}
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
          {b.lines.map((line, li) => (
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
          ))}
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
      const d: Data = { records, decisions, reasons, databases, batches, profiles };
      setData(d);
      setCounts(computeCounts(d));
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
    const [concepts, conceptTags, conceptExcerpts, snowballLinks] =
      await Promise.all([
        fetchAll("concepts"),
        fetchAll("concept_tags"),
        fetchAll("concept_excerpts"),
        fetchAll("snowball_links"),
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
      const ta = outcomeOf(taMap.get(r.id) ?? []);
      const ft = counts.taRecordIds.has(r.id)
        ? outcomeOf(ftMap.get(r.id) ?? [])
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

  function exportLogCsv() {
    if (!data) return;
    const reasonLabel = new Map(data.reasons.map((r) => [r.id, r.label]));
    const recById = new Map(data.records.map((r) => [r.id, r]));
    const rows = data.decisions.map((d) => {
      const rec = recById.get(d.record_id);
      const who = data.profiles.get(d.decided_by);
      return [
        d.decided_at,
        d.stage,
        d.decision,
        d.reason_id ? (reasonLabel.get(d.reason_id) ?? "") : "",
        who?.email ?? who?.display_name ?? d.decided_by,
        rec?.title ?? "",
        rec?.doi ?? "",
      ];
    });
    downloadFile(
      `${base}-screening-log.csv`,
      buildCsv(
        ["timestamp", "stage", "decision", "reason", "reviewer", "title", "doi"],
        rows
      ),
      "text/csv"
    );
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

  const card =
    "rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900";
  const exportBtn =
    "rounded-full border border-zinc-300 px-4 py-2 text-sm text-zinc-700 transition-colors hover:bg-zinc-100 disabled:opacity-40 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800";

  return (
    <main className="mx-auto w-full max-w-4xl flex-1 px-6 py-8">
      <h1 className="mb-1 text-2xl font-semibold text-zinc-900 dark:text-zinc-50">
        PRISMA and exports
      </h1>
      <p className="mb-6 text-sm text-zinc-500 dark:text-zinc-400">
        Every number here is computed live from the records and decisions;
        nothing is entered by hand.
      </p>

      {error && (
        <p className="mb-4 rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
          {error}
        </p>
      )}

      {!counts || !data ? (
        <p className="text-zinc-500 dark:text-zinc-400">Computing...</p>
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
              <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">
                Flow diagram
              </h2>
              <div className="flex gap-2">
                <button onClick={exportSvg} className={exportBtn}>
                  Download SVG
                </button>
                <button onClick={exportPng} className={exportBtn}>
                  Download PNG
                </button>
              </div>
            </div>
            <div className="overflow-x-auto rounded-lg border border-zinc-100 dark:border-zinc-800">
              <PrismaDiagram counts={counts} svgRef={svgRef} />
            </div>
          </section>

          <section className={`${card} mb-6`}>
            <h2 className="mb-3 text-lg font-semibold text-zinc-900 dark:text-zinc-50">
              Identification per source
            </h2>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-zinc-400">
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

          <section className={card}>
            <h2 className="mb-1 text-lg font-semibold text-zinc-900 dark:text-zinc-50">
              Exports
            </h2>
            <p className="mb-4 text-sm text-zinc-500 dark:text-zinc-400">
              The RIS files import directly into Zotero or Mendeley for full
              text reading and citing. The backup JSON contains the complete
              project; download one after every serious screening session.
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
        </>
      )}
    </main>
  );
}
