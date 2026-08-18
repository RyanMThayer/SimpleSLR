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
      ? raw.groups.map((g) => ({ terms: (g.terms ?? []).filter(Boolean) }))
      : [{ terms: [] }];
  return {
    groups,
    fields: { ...base.fields, ...(raw?.fields ?? {}) },
    limits: { ...base.limits, ...(raw?.limits ?? {}) },
  };
}

function cleanGroups(groups: SearchGroup[]): string[][] {
  return groups
    .map((g) => g.terms.map((t) => t.trim()).filter(Boolean))
    .filter((terms) => terms.length > 0);
}

function quote(term: string): string {
  // Quote phrases; leave single tokens (which may carry wildcards) bare.
  return /\s/.test(term) ? `"${term}"` : term;
}

/**
 * Build a boolean expression where each term is wrapped by wrapTerm.
 * Groups are AND'd; terms inside a group are OR'd.
 */
function build(
  groups: string[][],
  wrapTerm: (term: string) => string
): string {
  return groups
    .map((terms) => {
      const inner = terms.map(wrapTerm).join(" OR ");
      return terms.length > 1 ? `(${inner})` : inner;
    })
    .join(" AND ");
}

function selectedFields(fields: SearchFields): ("title" | "abstract" | "keywords")[] {
  const out: ("title" | "abstract" | "keywords")[] = [];
  if (fields.title) out.push("title");
  if (fields.abstract) out.push("abstract");
  if (fields.keywords) out.push("keywords");
  return out;
}

/** Generate the query string for one database. */
export function generateQuery(kind: DatabaseKind, config: SearchConfig): string {
  const groups = cleanGroups(config.groups);
  if (groups.length === 0) return "";
  const sel = selectedFields(config.fields);
  const allThree = sel.length === 3;
  const none = sel.length === 0;

  switch (kind) {
    case "scopus": {
      if (allThree || none) {
        return `TITLE-ABS-KEY ( ${build(groups, quote)} )`;
      }
      const codes = { title: "TITLE", abstract: "ABS", keywords: "KEY" } as const;
      return build(groups, (t) => {
        const per = sel.map((f) => `${codes[f]} ( ${quote(t)} )`);
        return per.length > 1 ? `(${per.join(" OR ")})` : per[0];
      });
    }
    case "wos": {
      if (allThree || none) {
        return `TS=(${build(groups, quote)})`;
      }
      const codes = { title: "TI", abstract: "AB", keywords: "AK" } as const;
      return build(groups, (t) => {
        const per = sel.map((f) => `${codes[f]}=(${quote(t)})`);
        return per.length > 1 ? `(${per.join(" OR ")})` : per[0];
      });
    }
    case "ieee": {
      const codes = {
        title: '"Document Title"',
        abstract: '"Abstract"',
        keywords: '"Author Keywords"',
      } as const;
      const use = none ? (["title", "abstract", "keywords"] as const) : sel;
      return build(groups, (t) => {
        const per = use.map((f) => `${codes[f]}:${quote(t)}`);
        return per.length > 1 ? `(${per.join(" OR ")})` : per[0];
      });
    }
    case "pubmed": {
      const wantsTiab = none || config.fields.title || config.fields.abstract;
      const wantsKw = none || config.fields.keywords;
      return build(groups, (t) => {
        const per: string[] = [];
        if (wantsTiab) per.push(`${quote(t)}[Title/Abstract]`);
        if (wantsKw) per.push(`${quote(t)}[Other Term]`);
        return per.length > 1 ? `(${per.join(" OR ")})` : per[0];
      });
    }
    default: {
      return build(groups, quote);
    }
  }
}

/** Human readable reminder of limits to apply in the database's own UI. */
export function limitsSummary(config: SearchConfig): string {
  const l = config.limits;
  const parts: string[] = [];
  if (l.yearFrom || l.yearTo) {
    parts.push(
      `years ${l.yearFrom ?? "any"} to ${l.yearTo ?? "present"}`
    );
  }
  if (l.languages.trim()) parts.push(`language: ${l.languages.trim()}`);
  if (l.pubTypes.trim()) parts.push(`publication types: ${l.pubTypes.trim()}`);
  return parts.join(" · ");
}

export const DEFAULT_DATABASES: { name: string; kind: DatabaseKind }[] = [
  { name: "Scopus", kind: "scopus" },
  { name: "Web of Science", kind: "wos" },
  { name: "IEEE Xplore", kind: "ieee" },
];

export const KIND_HINTS: Record<DatabaseKind, string> = {
  scopus: "Paste into Scopus Advanced search.",
  wos: "Paste into Web of Science Advanced Search (the query box). For the basic Topic search, remove the TS=( ) wrapper.",
  ieee: "Paste into the IEEE Xplore Advanced Search text box. IEEE limits wildcards (*) to a few per query.",
  pubmed: "Paste into the PubMed search box.",
  custom: "Generic boolean string. Adapt operators and field tags to this database's own syntax.",
};
