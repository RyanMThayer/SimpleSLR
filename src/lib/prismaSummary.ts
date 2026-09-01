import type { ProjectDatabase, SearchConfig } from "./types";
import { generateQuery, hydrateConfig } from "./searchQuery";
import { AI_MODELS } from "./aiModels";
import { kappaPhrase, type KappaResult } from "./kappa";

/**
 * The PRISMA reporting fact sheet: the verified numbers, dates,
 * strings, and settings behind the flow diagram, organized by PRISMA
 * 2020 checklist item. Deliberately NOT prose: researchers draft the
 * methods section in their own words from these facts, so the writing
 * stays theirs while the data stays exact. Gaps the team still has to
 * fill (a missing search date, an unrecorded search string) appear in
 * [brackets] so they are impossible to miss.
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

export type FactSheetInput = {
  searchConfig: Partial<SearchConfig> | null;
  databases: ProjectDatabase[];
  counts: SummaryCounts;
  memberCount: number;
  /** Preformatted date for the work-in-progress note. */
  asOf: string;
  /** Opinions required per record at each stage (1 = single screening). */
  requiredTa?: number;
  requiredFt?: number;
  /** Conflict resolutions recorded. */
  resolutionsCount?: number;
  /** Model ids used by the AI prescreen, when it removed anything. */
  prescreenModels?: string[];
  /** The recorded inclusion criteria text. */
  inclusionCriteria?: string | null;
  /** The exclusion reasons list, in position order. */
  reasonLabels?: string[];
  /** Inter-rater reliability per stage, when anything was dual screened. */
  reliability?: {
    ta: KappaResult | null;
    ft: KappaResult | null;
  };
};

export type FactRow = { label: string; value: string };
export type FactSection = {
  /** PRISMA 2020 checklist item, e.g. "Item 6". */
  item: string;
  title: string;
  rows: FactRow[];
  note?: string;
};

function modelLabel(id: string): string {
  return AI_MODELS.find((m) => m.id === id)?.label ?? id;
}

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

function fieldsPhrase(cfg: SearchConfig): string {
  if (cfg.fields.fullRecord) return "all searchable fields of each record";
  const sel: string[] = [];
  if (cfg.fields.title) sel.push("title");
  if (cfg.fields.abstract) sel.push("abstract");
  if (cfg.fields.keywords) sel.push("keywords");
  if (sel.length === 0 || sel.length === 3) {
    return "title, abstract, and keywords";
  }
  return listJoin(sel);
}

function reasonsBreakdown(byReason: { label: string; count: number }[]): string {
  return byReason.map((r) => `${r.label}, n = ${r.count}`).join("; ");
}

function armRows(a: SummaryArm, auto: boolean): FactRow[] {
  const rows: FactRow[] = [{ label: "Records identified", value: String(a.identified) }];
  if (auto && a.autoExcluded > 0) {
    rows.push({
      label: "Removed before screening by the automated prescreen",
      value: String(a.autoExcluded),
    });
  }
  rows.push(
    { label: "Duplicate records removed", value: String(a.duplicates) },
    { label: "Records screened (title and abstract)", value: String(a.screened) },
    { label: "Records excluded at title and abstract", value: String(a.taExcluded) },
    { label: "Reports sought for retrieval", value: String(a.sought) },
    { label: "Reports not retrieved", value: String(a.notRetrieved) },
    { label: "Reports assessed for eligibility", value: String(a.assessed) },
    {
      label: "Reports excluded at full text",
      value:
        a.ftExcluded > 0 && a.ftExcludedByReason.length > 0
          ? `${a.ftExcluded} (${reasonsBreakdown(a.ftExcludedByReason)})`
          : String(a.ftExcluded),
    },
    { label: "Studies included", value: String(a.ftIncluded) }
  );
  return rows;
}

export function buildPrismaFactSheet(input: FactSheetInput): FactSection[] {
  const c = input.counts;
  const cfg = hydrateConfig(input.searchConfig);
  const sections: FactSection[] = [];

  // ------------------------------------------------------------------
  // Item 5: eligibility criteria.
  // ------------------------------------------------------------------
  const critRows: FactRow[] = [
    {
      label: "Inclusion criteria",
      value: input.inclusionCriteria?.trim() || "[not recorded yet]",
    },
    {
      label: "Exclusion criteria",
      value:
        (input.reasonLabels ?? []).length > 0
          ? (input.reasonLabels ?? [])
              .map((l, i) => `E${i + 1}: ${l}`)
              .join("; ")
          : "[no exclusion reasons recorded yet]",
    },
  ];
  sections.push({
    item: "Item 5",
    title: "Eligibility criteria",
    rows: critRows,
  });

  // ------------------------------------------------------------------
  // Item 6: information sources.
  // ------------------------------------------------------------------
  const dbByName = new Map(input.databases.map((d) => [d.name, d]));
  const sources = c.perSource.filter((s) => !s.snowball);
  const searchedOnly = input.databases.filter(
    (d) => d.searched_on !== null && !sources.some((s) => s.name === d.name)
  );
  const srcRows: FactRow[] = [
    ...sources.map((s) => {
      const when = formatLongDate(dbByName.get(s.name)?.searched_on);
      const datePart = when ? `searched ${when}` : "[search date not recorded]";
      const countPart =
        s.rawHits !== null && s.rawHits !== s.imported
          ? `${plural(s.rawHits, "hit")}, ${s.imported} imported`
          : `${plural(s.imported, "record")} imported`;
      return { label: s.name, value: `${datePart} · ${countPart}` };
    }),
    ...searchedOnly.map((d) => ({
      label: d.name,
      value: `searched ${formatLongDate(d.searched_on)} · ${
        d.raw_hit_count !== null
          ? `${plural(d.raw_hit_count, "hit")}, none imported yet`
          : "no records imported yet"
      }`,
    })),
  ];
  if (c.other.identified > 0) {
    srcRows.push({
      label: "Citation searching",
      value: `backward and forward snowballing of included studies · ${plural(
        c.other.identified,
        "record"
      )} (${c.other.backward} from reference lists, ${c.other.forward} from citing works)`,
    });
  }
  if (srcRows.length === 0) {
    srcRows.push({
      label: "Sources",
      value: "[no searches or imports recorded yet]",
    });
  }
  sections.push({
    item: "Item 6",
    title: "Information sources",
    rows: srcRows,
  });

  // ------------------------------------------------------------------
  // Item 7: search strategy.
  // ------------------------------------------------------------------
  const searchString = generateQuery("custom", cfg);
  const stratRows: FactRow[] = [
    {
      label: "Search string",
      value:
        searchString ||
        "[not recorded yet; enter the search terms in the Discovery view]",
    },
    { label: "Fields searched", value: fieldsPhrase(cfg) },
  ];
  const l = cfg.limits;
  if (l.yearFrom !== null || l.yearTo !== null) {
    stratRows.push({
      label: "Publication years",
      value:
        l.yearFrom !== null && l.yearTo !== null
          ? `${l.yearFrom} to ${l.yearTo}`
          : l.yearFrom !== null
            ? `${l.yearFrom} or later`
            : `${l.yearTo} or earlier`,
    });
  }
  if (l.languages.trim()) {
    stratRows.push({ label: "Languages", value: l.languages.trim() });
  }
  if (l.pubTypes.trim()) {
    stratRows.push({ label: "Publication types", value: l.pubTypes.trim() });
  }
  sections.push({ item: "Item 7", title: "Search strategy", rows: stratRows });

  // ------------------------------------------------------------------
  // Item 8: selection process.
  // ------------------------------------------------------------------
  const kTa = input.requiredTa ?? 1;
  const kFt = input.requiredFt ?? 1;
  const selRows: FactRow[] = [
    {
      label: "Review team",
      value: plural(input.memberCount, "reviewer"),
    },
    {
      label: "Independent opinions per record",
      value: `${kTa} at title and abstract · ${kFt} at full text`,
    },
  ];
  if (kTa > 1 || kFt > 1) {
    selRows.push({
      label: "Blinding",
      value:
        "individual decisions concealed until each record reached its required number of assessments",
    });
  }
  if (input.reliability?.ta) {
    selRows.push({
      label: "Inter-rater reliability (title and abstract)",
      value: kappaPhrase(input.reliability.ta),
    });
  }
  if (input.reliability?.ft) {
    selRows.push({
      label: "Inter-rater reliability (full text)",
      value: kappaPhrase(input.reliability.ft),
    });
  }
  if ((input.resolutionsCount ?? 0) > 0) {
    selRows.push({
      label: "Conflicts resolved by discussion",
      value: String(input.resolutionsCount),
    });
  }
  const totalAuto = c.db.autoExcluded + c.other.autoExcluded;
  if (totalAuto > 0) {
    const models =
      (input.prescreenModels ?? []).length > 0
        ? listJoin((input.prescreenModels ?? []).map(modelLabel))
        : "large language models";
    selRows.push({
      label: "Automated prescreen",
      value: `${plural(totalAuto, "record")} removed before screening · ${models}, temperature 0 · removal requires unanimous votes citing the same recorded criterion with verbatim evidence, then a final plausibility check · the exact prompts are disclosed under How SimpleSLR works below`,
    });
  }
  sections.push({
    item: "Item 8",
    title: "Selection process",
    rows: selRows,
  });

  // ------------------------------------------------------------------
  // Item 16a: study selection results, per arm.
  // ------------------------------------------------------------------
  sections.push({
    item: "Item 16a",
    title: "Study selection · identified via databases",
    rows: armRows(c.db, true),
  });
  if (c.other.identified > 0) {
    sections.push({
      item: "Item 16a",
      title: "Study selection · identified via citation searching",
      rows: armRows(c.other, true),
    });
  }
  const totalRows: FactRow[] = [
    {
      label: "Studies included in the review",
      value:
        c.other.identified > 0
          ? `${c.ftIncluded} (${c.db.ftIncluded} via databases, ${c.other.ftIncluded} via citation searching)`
          : String(c.ftIncluded),
    },
  ];
  const unfinished = c.taUndecided + c.taConflicts + c.ftUndecided;
  sections.push({
    item: "Item 16a",
    title: "Total",
    rows: totalRows,
    note:
      unfinished > 0
        ? `[Screening is still in progress as of ${input.asOf}: ${plural(
            c.taUndecided,
            "record"
          )} undecided and ${c.taConflicts} in conflict at title and abstract, ${
            c.ftUndecided
          } awaiting a full text decision. These numbers are a live snapshot.]`
        : undefined,
  });

  return sections;
}

/** Plain text rendering of the fact sheet, for the copy button. */
export function factSheetText(sections: FactSection[]): string {
  return sections
    .map((s) =>
      [
        `${s.item} · ${s.title}`,
        ...s.rows.map((r) => `  ${r.label}: ${r.value}`),
        ...(s.note ? [`  ${s.note}`] : []),
      ].join("\n")
    )
    .join("\n\n");
}
