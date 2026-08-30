import type { Stage } from "./types";
import { stageStatus } from "./outcomes";

/**
 * Pure graph construction for the visual snowball map.
 *
 * Consolidation rule: one node per record, no matter how many seeds or
 * import routes produced it. A paper found from two seeds draws two
 * edges into the same node; a paper found through OpenAlex by one team
 * member and through a Scopus export by another was already merged by
 * dedup at import, so it appears once, carrying its surviving batch's
 * source. Sources therefore differentiate the node's SHAPE, never
 * fragment the graph.
 *
 * Status coloring never leaks blinded information: it reuses the same
 * settled-outcome engine as every list view, so a record below its
 * opinion quota reads "screening", not its hidden votes.
 */

export type MapStatus =
  | "included"
  | "excluded"
  | "conflict"
  | "screening"
  | "prescreened";

export type SourceKind = "openalex" | "file" | "manual" | "screening";

export type SnowballNode = {
  id: string;
  title: string;
  authors: string | null;
  year: number | null;
  isSeed: boolean;
  status: MapStatus;
  source: SourceKind;
  degree: number;
  /** "Webster 2002" style label for direct labeling on the map. */
  label: string;
  // d3-force mutates these in place.
  x?: number;
  y?: number;
  vx?: number;
  vy?: number;
  fx?: number | null;
  fy?: number | null;
};

export type SnowballEdge = {
  id: string;
  /** d3-force replaces these string ids with node object references. */
  source: string | SnowballNode;
  target: string | SnowballNode;
  seedId: string;
  recordId: string;
  direction: "backward" | "forward";
};

export type RecordLite = {
  id: string;
  title: string;
  authors: string | null;
  year: number | null;
  status: string;
  batch_id: string | null;
};

export type BatchLite = {
  id: string;
  filename: string | null;
  origin: string | null;
};

/** First author's surname plus year, for compact on-map labels. */
export function shortLabel(
  authors: string | null,
  year: number | null,
  title: string
): string {
  const first = (authors ?? "").split(/[;,]/)[0]?.trim() ?? "";
  // "J. Webster" and "Webster J." both reduce to the longest word.
  const surname =
    first
      .split(/\s+/)
      .filter((w) => w.replace(/\./g, "").length > 1)
      .sort((a, b) => b.length - a.length)[0] ?? "";
  const base = surname || title.split(/\s+/).slice(0, 2).join(" ");
  return year ? `${base} ${year}` : base;
}

/** Which import route produced this record, from its batch. */
export function sourceKindOf(batch: BatchLite | undefined): SourceKind {
  if (!batch || !batch.origin?.startsWith("snowball")) return "screening";
  if (batch.filename === "manual entry") return "manual";
  if (batch.filename) return "file";
  return "openalex";
}

/**
 * Map the two-stage settled outcomes onto one node status. A candidate
 * is "included" at its furthest settled stage, "excluded" or in
 * "conflict" the moment either stage settles that way, and
 * "screening" while anything is still open or blinded.
 */
export function mapStatus(
  recordStatus: string,
  taDecs: { decision: string }[],
  ftDecs: { decision: string }[],
  taRes: { decision: string } | undefined,
  ftRes: { decision: string } | undefined,
  required: (stage: Stage) => number
): MapStatus {
  if (recordStatus === "prescreen_excluded") return "prescreened";
  const ta = stageStatus(taDecs, taRes ?? null, required("title_abstract"));
  if (ta.kind === "excluded") return "excluded";
  if (ta.kind === "conflict") return "conflict";
  if (ta.kind !== "included") return "screening";
  const ft = stageStatus(ftDecs, ftRes ?? null, required("full_text"));
  if (ft.kind === "excluded") return "excluded";
  if (ft.kind === "conflict") return "conflict";
  if (ft.kind === "included") return "included";
  // Title/abstract included, full text still open.
  return ftDecs.length === 0 && !ftRes ? "included" : "screening";
}

export type LinkRow = {
  record_id: string;
  seed_record_id: string;
  direction: string;
};

export function buildSnowballGraph(input: {
  links: LinkRow[];
  records: Map<string, RecordLite>;
  batches: Map<string, BatchLite>;
  statusOf: (rec: RecordLite) => MapStatus;
}): { nodes: SnowballNode[]; edges: SnowballEdge[] } {
  const { links, records, batches, statusOf } = input;
  const nodes = new Map<string, SnowballNode>();
  const edges: SnowballEdge[] = [];
  const seen = new Set<string>();

  const addNode = (rec: RecordLite, isSeed: boolean): SnowballNode => {
    const existing = nodes.get(rec.id);
    if (existing) {
      // A record can be both a seed and someone's candidate; seedness
      // wins because it anchors the layout.
      if (isSeed) existing.isSeed = true;
      return existing;
    }
    const node: SnowballNode = {
      id: rec.id,
      title: rec.title,
      authors: rec.authors,
      year: rec.year,
      isSeed,
      status: statusOf(rec),
      source: isSeed
        ? "screening"
        : sourceKindOf(rec.batch_id ? batches.get(rec.batch_id) : undefined),
      degree: 0,
      label: shortLabel(rec.authors, rec.year, rec.title),
    };
    nodes.set(rec.id, node);
    return node;
  };

  for (const l of links) {
    const seed = records.get(l.seed_record_id);
    const rec = records.get(l.record_id);
    // Deleted records or ones merged away as duplicates leave the map;
    // their keeper carries its own links.
    if (!seed || !rec) continue;
    if (seed.status === "duplicate" || rec.status === "duplicate") continue;
    const dir = l.direction === "forward" ? "forward" : "backward";
    const key = `${l.seed_record_id}:${l.record_id}:${dir}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const seedNode = addNode(seed, true);
    const recNode = addNode(rec, false);
    seedNode.degree++;
    recNode.degree++;
    edges.push({
      id: key,
      source: l.seed_record_id,
      target: l.record_id,
      seedId: l.seed_record_id,
      recordId: l.record_id,
      direction: dir,
    });
  }

  return { nodes: [...nodes.values()], edges };
}

/** Node radius: seeds anchor large; candidates grow with corroboration. */
export function nodeRadius(n: SnowballNode): number {
  if (n.isSeed) return Math.min(26, 14 + n.degree * 1.2);
  return Math.min(16, 6 + (n.degree - 1) * 2.5);
}
