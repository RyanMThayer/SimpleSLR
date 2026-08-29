import type { ProjectDatabase, SearchConfig } from "./types";
import { generateQuery, hydrateConfig } from "./searchQuery";

/**
 * Builds the written PRISMA 2020 summary shown under the flow diagram:
 * plain prose covering the information sources, search string, limits,
 * and every selection number the diagram reports. Everything is derived
 * from live data; gaps the team still has to fill in (a missing search
 * date, an unrecorded search string) appear in [brackets] so they are
 * impossible to miss when pasting into a manuscript.
 */

/** Structural subset of the PRISMA page's per arm counters. */
export type SummaryArm = {
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

export type SummaryCounts = {
  identified: number;
  db: SummaryArm;
  other: SummaryArm;
  perSource: {
    name: string;
    imported: number;
    rawHits: number | null;
    snowball: boolean;
  }[];
  taUndecided: number;
  taConflicts: number;
  ftUndecided: number;
  ftIncluded: number;
};

export type SummaryInput = {
  searchConfig: Partial<SearchConfig> | null;
  databases: ProjectDatabase[];
  counts: SummaryCounts;
  memberCount: number;
  /** Preformatted date for the work-in-progress note, e.g. "August 24, 2026". */
  asOf: string;
};

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** "2026-06-17" to "June 17, 2026", with no timezone surprises. */
export function formatLongDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso.trim());
  if (!m) return iso;
  const month = MONTHS[parseInt(m[2], 10) - 1];
  const day = parseInt(m[3], 10);
  if (!month || !day) return iso;
  return `${month} ${day}, ${m[1]}`;
}

/** Oxford comma join: "A", "A and B", "A, B, and C". */
export function listJoin(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

/** "1 record" / "3 records"; pass the irregular plural when needed. */
export function plural(
  count: number,
  singular: string,
  pluralForm?: string
): string {
  return `${count} ${count === 1 ? singular : (pluralForm ?? `${singular}s`)}`;
}

function wasWere(count: number): string {
  return count === 1 ? "was" : "were";
}

function reasonsClause(byReason: { label: string; count: number }[]): string {
  return byReason.map((r) => `${r.label}, n = ${r.count}`).join("; ");
}

function fieldsPhrase(cfg: SearchConfig): string {
  if (cfg.fields.fullRecord) return "all searchable fields of each record";
  const sel: string[] = [];
  if (cfg.fields.title) sel.push("title");
  if (cfg.fields.abstract) sel.push("abstract");
  if (cfg.fields.keywords) sel.push("keywords");
  if (sel.length === 0 || sel.length === 3) {
    return "the title, abstract, and keywords";
  }
  return `the ${listJoin(sel)}`;
}

function limitsSentence(cfg: SearchConfig): string {
  const l = cfg.limits;
  const parts: string[] = [];
  if (l.yearFrom !== null && l.yearTo !== null) {
    parts.push(`published between ${l.yearFrom} and ${l.yearTo}`);
  } else if (l.yearFrom !== null) {
    parts.push(`published in ${l.yearFrom} or later`);
  } else if (l.yearTo !== null) {
    parts.push(`published in ${l.yearTo} or earlier`);
  }
  if (l.languages.trim()) parts.push(`written in ${l.languages.trim()}`);
  if (l.pubTypes.trim()) {
    parts.push(`of the following publication types: ${l.pubTypes.trim()}`);
  }
  if (parts.length === 0) return "";
  return ` Results were limited to records ${listJoin(parts)}.`;
}

export function buildPrismaSummary(input: SummaryInput): string[] {
  const c = input.counts;
  const cfg = hydrateConfig(input.searchConfig);

  const dbByName = new Map(input.databases.map((d) => [d.name, d]));
  const sources = c.perSource.filter((s) => !s.snowball);
  // Databases marked as searched that have no imports yet still belong
  // in the information sources sentence.
  const searchedOnly = input.databases.filter(
    (d) => d.searched_on !== null && !sources.some((s) => s.name === d.name)
  );

  if (sources.length === 0 && searchedOnly.length === 0 && c.identified === 0) {
    return [
      "Nothing to summarize yet: no searches or imports have been recorded. This summary writes itself from the live data as identification and screening progress.",
    ];
  }

  const paragraphs: string[] = [];

  // ------------------------------------------------------------------
  // Paragraph 1: information sources, search string, limits.
  // ------------------------------------------------------------------
  const sourceBits = [
    ...sources.map((s) => {
      const when = formatLongDate(dbByName.get(s.name)?.searched_on);
      const datePart = when ?? "[search date not recorded]";
      const countPart =
        s.rawHits !== null && s.rawHits !== s.imported
          ? `${plural(s.rawHits, "hit")}, of which ${s.imported} ${wasWere(s.imported)} imported`
          : `n = ${s.imported}`;
      return `${s.name} (${datePart}; ${countPart})`;
    }),
    ...searchedOnly.map((d) => {
      const when = formatLongDate(d.searched_on);
      const hits =
        d.raw_hit_count !== null
          ? `${plural(d.raw_hit_count, "hit")}, none imported yet`
          : "no records imported yet";
      return `${d.name} (${when}; ${hits})`;
    }),
  ];

  const p1: string[] = [];
  if (sourceBits.length > 0) {
    p1.push(`We searched ${listJoin(sourceBits)}.`);
  }
  const searchString = generateQuery("custom", cfg);
  if (searchString) {
    p1.push(
      `The search covered ${fieldsPhrase(cfg)} and used the following string, adapted to each database's own syntax: ${searchString}.`
    );
  } else {
    p1.push(
      "[No search string has been recorded yet; enter the search terms in the Discovery view so it can be reported here.]"
    );
  }
  const lim = limitsSentence(cfg);
  if (lim) p1.push(lim.trim());
  paragraphs.push(p1.join(" "));

  // ------------------------------------------------------------------
  // Paragraph 2: selection flow for the databases arm.
  // ------------------------------------------------------------------
  const a = c.db;
  if (a.identified === 0) {
    paragraphs.push("No records were identified through database searches.");
  } else {
    const p2: string[] = [];
    p2.push(
      `The database searches identified ${plural(a.identified, "record")}.`
    );
    if (a.autoExcluded > 0) {
      p2.push(
        `Before screening, ${plural(a.autoExcluded, "record")} ${wasWere(a.autoExcluded)} marked as ineligible by an automation tool (SimpleSLR's AI prescreen, which removes a record only when every vote of a multi-prompt model ensemble independently judges it clearly outside the eligibility criteria).`
      );
    }
    if (a.duplicates > 0) {
      p2.push(
        `After removal of ${plural(a.duplicates, "duplicate record")}, ${plural(a.screened, "record")} ${wasWere(a.screened)} screened on title and abstract, and ${a.taExcluded} of them ${wasWere(a.taExcluded)} excluded.`
      );
    } else {
      p2.push(
        `No duplicates were detected among them, and all ${a.screened} were screened on title and abstract; ${a.taExcluded} ${wasWere(a.taExcluded)} excluded.`
      );
    }
    p2.push(
      `Full texts were sought for the remaining ${plural(a.sought, "report")}; ${a.notRetrieved} could not be retrieved.`
    );
    const dbReasons =
      a.ftExcluded > 0 && a.ftExcludedByReason.length > 0
        ? ` (${reasonsClause(a.ftExcludedByReason)})`
        : "";
    p2.push(
      `The ${plural(a.assessed, "report")} obtained ${wasWere(a.assessed)} assessed against the eligibility criteria, and ${a.ftExcluded} ${wasWere(a.ftExcluded)} excluded${dbReasons}.`
    );
    p2.push(
      `This left ${plural(a.ftIncluded, "study", "studies")} from the database searches.`
    );
    paragraphs.push(p2.join(" "));
  }

  // ------------------------------------------------------------------
  // Paragraph 3: citation searching arm, when it exists.
  // ------------------------------------------------------------------
  const o = c.other;
  if (o.identified > 0) {
    const p3: string[] = [];
    p3.push(
      `To supplement the database searches, backward and forward citation searching of the included studies identified a further ${plural(o.identified, "record")} (${o.backward} from reference lists and ${o.forward} from citing works).`
    );
    if (o.duplicates > 0) {
      p3.push(
        `Of these, ${plural(o.duplicates, "duplicate")} ${wasWere(o.duplicates)} removed.`
      );
    }
    p3.push(
      `These records went through the same two stage screening: ${o.taExcluded} ${wasWere(o.taExcluded)} excluded on title and abstract, full texts were sought for ${plural(o.sought, "report")} (${o.notRetrieved} not retrieved), and of the ${plural(o.assessed, "report")} assessed, ${o.ftExcluded} ${wasWere(o.ftExcluded)} excluded${
        o.ftExcluded > 0 && o.ftExcludedByReason.length > 0
          ? ` (${reasonsClause(o.ftExcludedByReason)})`
          : ""
      }.`
    );
    p3.push(
      `Citation searching contributed ${plural(o.ftIncluded, "additional included study", "additional included studies")}.`
    );
    paragraphs.push(p3.join(" "));
  }

  // ------------------------------------------------------------------
  // Paragraph 4: process, totals, and the work-in-progress note.
  // ------------------------------------------------------------------
  const p4: string[] = [];
  p4.push(
    `Screening at both stages was performed in SimpleSLR by the ${plural(input.memberCount, "member")} of the review team, without any automation or AI assistance in the screening decisions.`
  );
  if (o.identified > 0) {
    p4.push(
      `In total, ${plural(c.ftIncluded, "study", "studies")} met all criteria: ${a.ftIncluded} identified through database searching and ${o.ftIncluded} through citation searching.`
    );
  } else {
    p4.push(
      `In total, ${plural(c.ftIncluded, "study", "studies")} met all criteria.`
    );
  }
  const unfinished = c.taUndecided + c.taConflicts + c.ftUndecided;
  if (unfinished > 0) {
    p4.push(
      `[Screening is still in progress as of ${input.asOf}: ${plural(c.taUndecided, "record")} undecided and ${c.taConflicts} in conflict at title and abstract, with ${c.ftUndecided} awaiting a full text decision. The numbers above are a live snapshot and will change until screening is complete.]`
    );
  }
  paragraphs.push(p4.join(" "));

  return paragraphs;
}
