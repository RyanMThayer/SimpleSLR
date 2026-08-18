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
