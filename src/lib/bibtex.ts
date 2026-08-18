import type { ParsedRef } from "./types";

/**
 * Minimal BibTeX parser covering the fields SimpleSLR needs.
 * Handles brace and quote delimited values, nested braces, and the
 * common export shapes of Scopus, IEEE, ACM, and Google Scholar.
 */
export function parseBibtex(text: string): ParsedRef[] {
  const refs: ParsedRef[] = [];
  let i = 0;

  while (i < text.length) {
    const at = text.indexOf("@", i);
    if (at === -1) break;
    // Entry type
    let j = at + 1;
    while (j < text.length && /[a-zA-Z]/.test(text[j])) j++;
    const type = text.slice(at + 1, j).toLowerCase();
    while (j < text.length && /\s/.test(text[j])) j++;
    if (text[j] !== "{" && text[j] !== "(") {
      i = at + 1;
      continue;
    }
    const open = text[j];
    const close = open === "{" ? "}" : ")";
    // Find the matching closing delimiter.
    let depth = 1;
    let k = j + 1;
    while (k < text.length && depth > 0) {
      if (text[k] === open || (open === "{" && text[k] === "{")) depth++;
      else if (text[k] === close || (open === "{" && text[k] === "}")) depth--;
      k++;
    }
    const body = text.slice(j + 1, k - 1);
    i = k;

    if (type === "comment" || type === "preamble" || type === "string") continue;

    const fields = parseFields(body);
    const title = fields.get("title");
    if (!title) continue;

    const yearRaw = fields.get("year");
    const yearMatch = yearRaw?.match(/\d{4}/);
    const authorsRaw = fields.get("author");
    refs.push({
      title: cleanTex(title),
      authors: authorsRaw
        ? cleanTex(authorsRaw).split(/\s+and\s+/i).join("; ")
        : null,
      year: yearMatch ? parseInt(yearMatch[0], 10) : null,
      venue: cleanTex(
        fields.get("journal") ??
          fields.get("booktitle") ??
          fields.get("publisher") ??
          ""
      ) || null,
      abstract: fields.get("abstract") ? cleanTex(fields.get("abstract")!) : null,
      doi: fields.get("doi") ? cleanTex(fields.get("doi")!) : null,
      url: fields.get("url") ? fields.get("url")!.trim() : null,
    });
  }
  return refs;
}

/** Parse "name = value" pairs from an entry body (after the cite key). */
function parseFields(body: string): Map<string, string> {
  const fields = new Map<string, string>();
  // Skip the cite key (everything before the first comma at depth 0).
  let i = body.indexOf(",");
  if (i === -1) return fields;
  i++;

  while (i < body.length) {
    // Field name
    while (i < body.length && /[\s,]/.test(body[i])) i++;
    let j = i;
    while (j < body.length && /[a-zA-Z_-]/.test(body[j])) j++;
    const name = body.slice(i, j).toLowerCase();
    if (!name) break;
    while (j < body.length && /\s/.test(body[j])) j++;
    if (body[j] !== "=") {
      i = j + 1;
      continue;
    }
    j++;
    while (j < body.length && /\s/.test(body[j])) j++;

    let value = "";
    if (body[j] === "{") {
      let depth = 1;
      let k = j + 1;
      while (k < body.length && depth > 0) {
        if (body[k] === "{") depth++;
        else if (body[k] === "}") depth--;
        if (depth > 0) value += body[k];
        k++;
      }
      i = k;
    } else if (body[j] === '"') {
      let k = j + 1;
      while (k < body.length && body[k] !== '"') {
        value += body[k];
        k++;
      }
      i = k + 1;
    } else {
      // Bare number or macro: read until comma.
      let k = j;
      while (k < body.length && body[k] !== ",") {
        value += body[k];
        k++;
      }
      i = k;
    }
    if (name && value.trim()) fields.set(name, value.trim());
  }
  return fields;
}

/** Strip common LaTeX escapes and braces from a field value. */
function cleanTex(s: string): string {
  return s
    .replace(/\\['"`^~=.uvHtcdbaoe]\s?\{?([a-zA-Z])\}?/g, "$1") // accents
    .replace(/\\[a-zA-Z]+\s*/g, " ") // other commands
    .replace(/[{}]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
