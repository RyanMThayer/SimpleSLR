import type { ParsedRef } from "./types";

/**
 * Minimal RIS parser covering the fields SimpleSLR needs.
 * RIS is a line based format: "TAG  - value", records end with "ER  -".
 * Handles exports from Scopus, Web of Science, and IEEE Xplore.
 */
export function parseRis(text: string): ParsedRef[] {
  const refs: ParsedRef[] = [];
  const lines = text.split(/\r\n|\r|\n/);

  let current: Record<string, string[]> = {};
  let lastTag: string | null = null;

  const flush = () => {
    if (Object.keys(current).length === 0) return;
    const get = (tag: string): string | null =>
      current[tag]?.length ? current[tag].join(" ").trim() || null : null;
    const getFirst = (...tags: string[]): string | null => {
      for (const t of tags) {
        const v = get(t);
        if (v) return v;
      }
      return null;
    };

    const title = getFirst("TI", "T1");
    if (title) {
      const authors = current["AU"]?.length
        ? current["AU"].join("; ")
        : current["A1"]?.length
          ? current["A1"].join("; ")
          : null;
      const yearRaw = getFirst("PY", "Y1", "DA");
      const yearMatch = yearRaw?.match(/\d{4}/);
      refs.push({
        title,
        authors,
        year: yearMatch ? parseInt(yearMatch[0], 10) : null,
        venue: getFirst("T2", "JO", "JF", "J2", "BT", "CY") ?? null,
        abstract: getFirst("AB", "N2"),
        doi: getFirst("DO", "DI"),
        url: getFirst("UR", "L1", "L2"),
      });
    }
    current = {};
    lastTag = null;
  };

  for (const rawLine of lines) {
    const line = rawLine.replace(/\u00a0/g, " ");
    const m = line.match(/^([A-Z][A-Z0-9])\s{2}-\s?(.*)$/);
    if (m) {
      const [, tag, value] = m;
      if (tag === "ER") {
        flush();
        continue;
      }
      if (!current[tag]) current[tag] = [];
      if (value.trim()) current[tag].push(value.trim());
      lastTag = tag;
    } else if (lastTag && line.trim()) {
      // Continuation line: append to the previous tag's last value.
      const arr = current[lastTag];
      if (arr && arr.length > 0) {
        arr[arr.length - 1] += " " + line.trim();
      } else if (arr) {
        arr.push(line.trim());
      }
    }
  }
  flush(); // in case the file lacks a trailing ER

  return refs;
}
