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

export type MapStatus = "included" | "excluded" | "conflict" | "screening";

export type SourceKind = "openalex" | "file" | "manual" | "screening";

export type SnowballNode = {
  id: string;
  title: string;
  authors: string | null;
  year: number | null;
  isSeed: boolean;
  status: MapStatus;
  /** Title/abstract screening settled include (seeds trivially true),
   * regardless of where full text screening stands. */
  taIncluded: boolean;
  /** True when the record itself was CREATED by a snowball import.
   * False means the corpus already held it (database search arm), so
   * a citation link to it is a rediscovery, not a snowball find: the
   * map draws it, the flow view must never count it. */
  snowballed: boolean;
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
  /** Keeper pointer for duplicate rows; links resolve through it. */
  duplicate_of?: string | null;
};

export type BatchLite = {
  id: string;
  filename: string | null;
  origin: string | null;
};

/**
 * Split an authors field into per-author entries across the formats
 * the import routes produce: "; " separated (RIS, BibTeX, OpenAlex all
 * join with it), "and"/"&" separated, or comma separated, where a
 * single word before the first comma marks surname-first pairs
 * ("Webster, J., Watson, R.") and anything else marks full names
 * ("Jane Webster, Richard Watson").
 */
export function authorEntries(authors: string | null): string[] {
  const s = (authors ?? "").trim();
  if (!s) return [];
  if (s.includes(";")) {
    return s
      .split(";")
      .map((x) => x.trim())
      .filter(Boolean);
  }
  const andParts = s
    .split(/\s+and\s+|\s*&\s*/i)
    .map((x) => x.trim())
    .filter(Boolean);
  if (andParts.length > 1) return andParts;
  const segs = s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  if (segs.length <= 1) return segs;
  if (!/\s/.test(segs[0])) {
    // Surname-first pairs: stitch "Webster" + "J." back together.
    const out: string[] = [];
    for (let i = 0; i < segs.length; i += 2) {
      out.push(segs[i + 1] ? `${segs[i]}, ${segs[i + 1]}` : segs[i]);
    }
    return out;
  }
  return segs;
}

/**
 * Surname of one author entry. A single word before a comma is the
 * surname ("Webster, J."); otherwise names read given-first and the
 * surname is the LAST full word ("Jane Webster", "Alexander Smith"),
 * never the longest one, which used to surface long first names.
 * Initials and generational suffixes never count as the surname.
 */
export function surnameOf(entry: string): string {
  const trimmed = entry.trim();
  const comma = trimmed.indexOf(",");
  // Everything before a comma; the whole entry when there is none.
  const head = comma > 0 ? trimmed.slice(0, comma).trim() : trimmed;
  if (comma > 0 && !/\s/.test(head)) return head;
  const words = head
    .split(/\s+/)
    .filter((w) => w.replace(/[.'-]/g, "").length > 1)
    .filter((w) => !/^(jr|sr|ii|iii|iv)\.?$/i.test(w));
  return (
    words[words.length - 1] ?? head.split(/\s+/).filter(Boolean).pop() ?? ""
  );
}

/**
 * Citation-style node label: "Webster 2002" for one author,
 * "Webster and Watson 2002" for two, "Smith et al. 2005" for three or
 * more; the title's first words stand in when no author parsed.
 */
export function shortLabel(
  authors: string | null,
  year: number | null,
  title: string
): string {
  const entries = authorEntries(authors);
  const surname = entries.length > 0 ? surnameOf(entries[0]) : "";
  let base: string;
  if (!surname) {
    base = title.split(/\s+/).slice(0, 2).join(" ");
  } else if (entries.length >= 3) {
    base = `${surname} et al.`;
  } else if (entries.length === 2) {
    const second = surnameOf(entries[1]);
    base = second ? `${surname} and ${second}` : `${surname} et al.`;
  } else {
    base = surname;
  }
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
 * "conflict" the moment either stage settles that way (AI prescreen
 * removals read plain "excluded" here; the records table keeps their
 * provenance), and "screening" while anything is still open or blinded.
 */
export function mapStatus(
  recordStatus: string,
  taDecs: { decision: string }[],
  ftDecs: { decision: string }[],
  taRes: { decision: string } | undefined,
  ftRes: { decision: string } | undefined,
  required: (stage: Stage) => number
): MapStatus {
  if (recordStatus === "prescreen_excluded") return "excluded";
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
  taPassedOf?: (rec: RecordLite) => boolean;
}): { nodes: SnowballNode[]; edges: SnowballEdge[] } {
  const { links, records, batches, statusOf, taPassedOf } = input;
  const nodes = new Map<string, SnowballNode>();
  const edges: SnowballEdge[] = [];
  const seen = new Set<string>();

  const addNode = (rec: RecordLite, isSeed: boolean): SnowballNode => {
    const existing = nodes.get(rec.id);
    if (existing) {
      // A record can be both a seed and someone's candidate; seedness
      // wins because it anchors the layout.
      if (isSeed) {
        existing.isSeed = true;
        existing.taIncluded = true;
      }
      return existing;
    }
    const node: SnowballNode = {
      id: rec.id,
      title: rec.title,
      authors: rec.authors,
      year: rec.year,
      isSeed,
      status: statusOf(rec),
      taIncluded: isSeed || (taPassedOf?.(rec) ?? false),
      snowballed: Boolean(
        rec.batch_id &&
          batches.get(rec.batch_id)?.origin?.startsWith("snowball")
      ),
      source: isSeed
        ? "screening"
        : sourceKindOf(rec.batch_id ? batches.get(rec.batch_id) : undefined),
      degree: 0,
      label: shortLabel(rec.authors, rec.year, rec.title),
    };
    nodes.set(rec.id, node);
    return node;
  };

  // A link that lands on a duplicate row follows duplicate_of to the
  // keeper: THIS is how cross-seed overlap survives, because a paper
  // one seed already surfaced arrives from the next seed as a
  // duplicate whose link must fold onto the keeper's node. Chains are
  // walked with a hop cap; a duplicate with no surviving keeper drops.
  const resolve = (id: string): RecordLite | undefined => {
    let rec = records.get(id);
    for (let hop = 0; rec && rec.status === "duplicate" && hop < 8; hop++) {
      const next = rec.duplicate_of ? records.get(rec.duplicate_of) : undefined;
      if (!next || next.id === rec.id) break;
      rec = next;
    }
    return rec;
  };

  for (const l of links) {
    const seed = resolve(l.seed_record_id);
    const rec = resolve(l.record_id);
    if (!seed || !rec) continue;
    if (seed.status === "duplicate" || rec.status === "duplicate") continue;
    // Resolution can fold a link back onto its own seed.
    if (seed.id === rec.id) continue;
    // The seed was snowballed FROM, so it belongs on the map even if
    // every one of its citations lands on filtered-out records.
    const seedNode = addNode(seed, true);
    // PROVENANCE RULE: an arrow means "this record surfaced through
    // snowballing from this seed", nothing else. A citation landing on
    // a record the corpus already held (a seed citing another seed is
    // the common case) is real citation structure, but it is not how
    // that record surfaced in the search, so it draws nothing.
    const recSnowballed = Boolean(
      rec.batch_id && batches.get(rec.batch_id)?.origin?.startsWith("snowball")
    );
    if (!recSnowballed) continue;
    const dir = l.direction === "forward" ? "forward" : "backward";
    const key = `${seed.id}:${rec.id}:${dir}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const recNode = addNode(rec, false);
    seedNode.degree++;
    recNode.degree++;
    edges.push({
      id: key,
      source: seed.id,
      target: rec.id,
      seedId: seed.id,
      recordId: rec.id,
      direction: dir,
    });
  }

  return { nodes: [...nodes.values()], edges };
}

/**
 * Round structure of the search, for the flow view. Generation 1
 * sources are seeds the corpus held before snowballing (the database
 * arm); a snowball-found paper that was later snowballed from sits one
 * round after the seed that FIRST found it. First-finder attribution
 * follows link creation order, matching the flow view's counting, and
 * anything with no traceable finder falls back to round 1 rather than
 * vanishing. Chains are capped at 6 rounds.
 */
export function flowGenerations(
  nodes: SnowballNode[],
  edges: SnowballEdge[]
): { finderOf: Map<string, string>; genOf: Map<string, number> } {
  const finderOf = new Map<string, string>();
  edges.forEach((e) => {
    if (!finderOf.has(e.recordId)) finderOf.set(e.recordId, e.seedId);
  });
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const genOf = new Map<string, number>();
  const gen = (id: string, hops: number): number => {
    const cached = genOf.get(id);
    if (cached) return cached;
    const n = byId.get(id);
    const finder = finderOf.get(id);
    const g =
      !n || !n.snowballed || !finder || hops >= 6
        ? 1
        : gen(finder, hops + 1) + 1;
    genOf.set(id, g);
    return g;
  };
  nodes.forEach((n) => gen(n.id, 0));
  return { finderOf, genOf };
}

/** Node radius: seeds anchor large; candidates grow with corroboration. */
export function nodeRadius(n: SnowballNode): number {
  if (n.isSeed) return Math.min(26, 14 + n.degree * 1.2);
  return Math.min(16, 6 + (n.degree - 1) * 2.5);
}
