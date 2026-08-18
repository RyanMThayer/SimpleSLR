import type {
  DatabaseKind,
  SearchConfig,
  SearchFields,
  SearchGroup,
} from "./types";
import { EMPTY_SEARCH_CONFIG } from "./types";

/** Fill in any missing parts of a stored (possibly partial) config. */
export function hydrateConfig(
  raw: Partial<SearchConfig> | null | undefined
): SearchConfig {
  const base = EMPTY_SEARCH_CONFIG;
  const groups =
    raw?.groups && raw.groups.length > 0
      ? raw.groups.map((g) => ({
          terms: (g.terms ?? []).filter(Boolean),
          not: Boolean(g.not),
        }))
      : [{ terms: [], not: false }];
  return {
    groups,
    fields: { ...base.fields, ...(raw?.fields ?? {}) },
    limits: { ...base.limits, ...(raw?.limits ?? {}) },
  };
}

type CleanGroup = { terms: string[]; not: boolean };

function cleanGroups(groups: SearchGroup[]): CleanGroup[] {
  return groups
    .map((g) => ({
      terms: g.terms.map((t) => t.trim()).filter(Boolean),
      not: Boolean(g.not),
    }))
    .filter((g) => g.terms.length > 0);
}

function quote(term: string): string {
  // Quote phrases; leave single tokens (which may carry wildcards) bare.
  return /\s/.test(term) ? `"${term}"` : term;
}

/** OR the wrapped terms of one group, parenthesized when needed. */
function groupExpr(terms: string[], wrapTerm: (t: string) => string): string {
  const inner = terms.map(wrapTerm).join(" OR ");
  return terms.length > 1 ? `(${inner})` : inner;
}

/**
 * Build the full expression: positive groups AND'd, then each NOT group
 * appended with the database's negation operator.
 */
function buildExpr(
  groups: CleanGroup[],
  wrapTerm: (t: string) => string,
  notOperator: string
): string {
  const positive = groups.filter((g) => !g.not);
  const negative = groups.filter((g) => g.not);
  let expr = positive.map((g) => groupExpr(g.terms, wrapTerm)).join(" AND ");
  for (const g of negative) {
    const neg = groupExpr(g.terms, wrapTerm);
    expr = expr
      ? `${expr} ${notOperator} ${neg.startsWith("(") ? neg : `(${neg})`}`
      : `${notOperator} (${neg})`;
  }
  return expr;
}

function selectedFields(
  fields: SearchFields
): ("title" | "abstract" | "keywords")[] {
  const out: ("title" | "abstract" | "keywords")[] = [];
  if (fields.title) out.push("title");
  if (fields.abstract) out.push("abstract");
  if (fields.keywords) out.push("keywords");
  return out;
}

/** Generate the query string for one database. */
export function generateQuery(kind: DatabaseKind, config: SearchConfig): string {
  const groups = cleanGroups(config.groups);
  if (groups.length === 0 || groups.every((g) => g.not)) return "";
  const full = config.fields.fullRecord;
  const sel = selectedFields(config.fields);
  const allThree = sel.length === 3;
  const none = sel.length === 0;

  switch (kind) {
    case "scopus": {
      if (full) return `ALL ( ${buildExpr(groups, quote, "AND NOT")} )`;
      if (allThree || none) {
        return `TITLE-ABS-KEY ( ${buildExpr(groups, quote, "AND NOT")} )`;
      }
      const codes = { title: "TITLE", abstract: "ABS", keywords: "KEY" } as const;
      return buildExpr(
        groups,
        (t) => {
          const per = sel.map((f) => `${codes[f]} ( ${quote(t)} )`);
          return per.length > 1 ? `(${per.join(" OR ")})` : per[0];
        },
        "AND NOT"
      );
    }
    case "wos": {
      if (full) return `ALL=(${buildExpr(groups, quote, "NOT")})`;
      if (allThree || none) {
        return `TS=(${buildExpr(groups, quote, "NOT")})`;
      }
      const codes = { title: "TI", abstract: "AB", keywords: "AK" } as const;
      return buildExpr(
        groups,
        (t) => {
          const per = sel.map((f) => `${codes[f]}=(${quote(t)})`);
          return per.length > 1 ? `(${per.join(" OR ")})` : per[0];
        },
        "NOT"
      );
    }
    case "ieee": {
      const codes = {
        title: '"Document Title"',
        abstract: '"Abstract"',
        keywords: '"Author Keywords"',
      } as const;
      if (full) {
        return buildExpr(groups, (t) => `"All Metadata":${quote(t)}`, "NOT");
      }
      const use = none ? (["title", "abstract", "keywords"] as const) : sel;
      return buildExpr(
        groups,
        (t) => {
          const per = use.map((f) => `${codes[f]}:${quote(t)}`);
          return per.length > 1 ? `(${per.join(" OR ")})` : per[0];
        },
        "NOT"
      );
    }
    case "pubmed": {
      if (full) return buildExpr(groups, quote, "NOT");
      const wantsTiab = none || config.fields.title || config.fields.abstract;
      const wantsKw = none || config.fields.keywords;
      return buildExpr(
        groups,
        (t) => {
          const per: string[] = [];
          if (wantsTiab) per.push(`${quote(t)}[Title/Abstract]`);
          if (wantsKw) per.push(`${quote(t)}[Other Term]`);
          return per.length > 1 ? `(${per.join(" OR ")})` : per[0];
        },
        "NOT"
      );
    }
    default: {
      return buildExpr(groups, quote, "AND NOT");
    }
  }
}

/** Human readable reminder of limits to apply in the database's own UI. */
export function limitsSummary(config: SearchConfig): string {
  const l = config.limits;
  const parts: string[] = [];
  if (l.yearFrom || l.yearTo) {
    parts.push(`years ${l.yearFrom ?? "any"} to ${l.yearTo ?? "present"}`);
  }
  if (l.languages.trim()) parts.push(`language: ${l.languages.trim()}`);
  if (l.pubTypes.trim()) parts.push(`publication types: ${l.pubTypes.trim()}`);
  return parts.join(" · ");
}

/**
 * Standard databases preloaded into every review. Selection based on
 * Gusenbauer and Haddaway (2020), Research Synthesis Methods 11(2),
 * which evaluated 28 academic search systems for systematic review
 * suitability, plus field staples for information systems research.
 */
export const STANDARD_DATABASES: {
  name: string;
  kind: DatabaseKind;
  defaultEnabled?: boolean;
  note?: string;
}[] = [
  { name: "Scopus", kind: "scopus", defaultEnabled: true },
  { name: "Web of Science Core Collection", kind: "wos", defaultEnabled: true },
  { name: "IEEE Xplore", kind: "ieee", defaultEnabled: true },
  { name: "ACM Digital Library", kind: "custom" },
  { name: "PubMed", kind: "pubmed" },
  { name: "ScienceDirect", kind: "custom" },
  { name: "SpringerLink", kind: "custom" },
  { name: "Wiley Online Library", kind: "custom" },
  { name: "EBSCOhost", kind: "custom" },
  { name: "ProQuest", kind: "custom" },
  { name: "JSTOR", kind: "custom" },
  { name: "AIS eLibrary", kind: "custom" },
  { name: "Cochrane Library", kind: "custom" },
  { name: "ERIC", kind: "custom" },
  {
    name: "Google Scholar",
    kind: "custom",
    note:
      "Supplementary source only: limited boolean support and no reliable bulk export. Gusenbauer and Haddaway (2020) rate it unsuitable as a principal SLR database.",
  },
];

export const KIND_HINTS: Record<DatabaseKind, string> = {
  scopus: "Paste into Scopus Advanced search.",
  wos: "Paste into Web of Science Advanced Search (the query box). For the basic Topic search, remove the TS=( ) wrapper.",
  ieee: "Paste into the IEEE Xplore Advanced Search text box. IEEE limits wildcards (*) to a few per query.",
  pubmed: "Paste into the PubMed search box.",
  custom: "Generic boolean string. Adapt operators and field tags to this database's own syntax.",
};
