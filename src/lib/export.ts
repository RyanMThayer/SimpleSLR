import type { RecordRow } from "./types";

/** Trigger a browser download of the given content. */
export function downloadFile(
  filename: string,
  content: string,
  mime: string
): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** Sanitize a project name into a filename fragment. */
export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "simpleslr"
  );
}

/**
 * Build a RIS file from records. Type is exported as JOUR because
 * SimpleSLR does not track publication types; adjust in Zotero after
 * import where needed.
 */
export function buildRis(records: RecordRow[]): string {
  const lines: string[] = [];
  for (const r of records) {
    lines.push("TY  - JOUR");
    lines.push(`TI  - ${r.title}`);
    if (r.authors) {
      for (const a of r.authors.split(/;\s*/).filter(Boolean)) {
        lines.push(`AU  - ${a}`);
      }
    }
    if (r.year !== null) lines.push(`PY  - ${r.year}`);
    if (r.venue) lines.push(`T2  - ${r.venue}`);
    if (r.abstract) lines.push(`AB  - ${r.abstract.replace(/\s*\n\s*/g, " ")}`);
    if (r.doi) lines.push(`DO  - ${r.doi}`);
    if (r.url) lines.push(`UR  - ${r.url}`);
    lines.push("ER  - ");
    lines.push("");
  }
  return lines.join("\r\n");
}

/**
 * Escape the characters that are special to LaTeX inside a BibTeX
 * field value. Single pass so an escape sequence is never re-escaped.
 */
export function escapeBibtex(value: string): string {
  let out = "";
  for (const ch of value) {
    switch (ch) {
      case "\\":
        out += "\\textbackslash{}";
        break;
      case "&":
      case "%":
      case "$":
      case "#":
      case "_":
        out += `\\${ch}`;
        break;
      case "{":
        out += "\\{";
        break;
      case "}":
        out += "\\}";
        break;
      case "~":
        out += "\\textasciitilde{}";
        break;
      case "^":
        out += "\\textasciicircum{}";
        break;
      default:
        out += ch;
    }
  }
  return out.replace(/\s*\n\s*/g, " ");
}

/**
 * Citation key fragment from the first author entry: the surname,
 * lowercased, diacritics stripped, non-alphanumerics removed.
 */
export function bibtexKeyStem(authors: string | null): string {
  const first = (authors ?? "").split(/;\s*/)[0]?.trim() ?? "";
  const surname = first.includes(",")
    ? first.slice(0, first.indexOf(",")).trim()
    : (first.split(/\s+/).pop() ?? "");
  const clean = surname
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9]/g, "")
    .toLowerCase();
  return clean || "record";
}

/**
 * Build a BibTeX file from records. Entries are exported as @article
 * because SimpleSLR does not track publication types; adjust in the
 * reference manager after import where needed. Keys are
 * surnameYEAR with a, b, c suffixes on collisions.
 */
export function buildBibtex(records: RecordRow[]): string {
  const used = new Set<string>();
  const entries = records.map((r) => {
    const base = `${bibtexKeyStem(r.authors)}${r.year ?? ""}` || "record";
    let key = base;
    for (let s = 0; used.has(key); s++) {
      key = `${base}${String.fromCharCode(97 + (s % 26))}${s >= 26 ? Math.floor(s / 26) : ""}`;
    }
    used.add(key);

    const fields: [string, string][] = [["title", escapeBibtex(r.title)]];
    if (r.authors) {
      const names = r.authors.split(/;\s*/).filter(Boolean).map(escapeBibtex);
      if (names.length) fields.push(["author", names.join(" and ")]);
    }
    if (r.year !== null) fields.push(["year", String(r.year)]);
    if (r.venue) fields.push(["journal", escapeBibtex(r.venue)]);
    if (r.doi) fields.push(["doi", escapeBibtex(r.doi)]);
    if (r.url) fields.push(["url", escapeBibtex(r.url)]);
    if (r.abstract) fields.push(["abstract", escapeBibtex(r.abstract)]);

    const body = fields.map(([k, v]) => `  ${k} = {${v}}`).join(",\n");
    return `@article{${key},\n${body}\n}`;
  });
  return entries.join("\n\n") + "\n";
}

/** Build a CSV string with proper quoting. */
export function buildCsv(header: string[], rows: (string | number | null)[][]): string {
  const escape = (v: string | number | null): string => {
    if (v === null || v === undefined) return "";
    const s = String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [header, ...rows]
    .map((row) => row.map(escape).join(","))
    .join("\r\n");
}
