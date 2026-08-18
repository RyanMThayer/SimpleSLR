import type { SearchGroup } from "./types";

/**
 * Parse a pasted boolean search string into the builder's model:
 * concept groups (terms OR'd) combined with AND, plus NOT groups.
 *
 * Handles: quoted phrases (straight and curly quotes), AND/OR/NOT in any
 * case, && and ||, Scopus's AND NOT, nested parentheses, implicit AND,
 * database field wrappers (TITLE-ABS-KEY(), TS=(), TITLE(), [tiab], ...),
 * proximity operators (treated as AND), and unbalanced parentheses.
 *
 * Anything that cannot be represented exactly in the flat
 * AND-of-OR-groups model is flattened with an explicit warning, never
 * silently dropped.
 */

export type ParseResult =
  | { ok: true; groups: SearchGroup[]; warnings: string[] }
  | { ok: false; error: string };

// ----------------------------------------------------------------------
// AST
// ----------------------------------------------------------------------

type Node =
  | { type: "term"; value: string }
  | { type: "and"; children: Node[] }
  | { type: "or"; children: Node[] }
  | { type: "not"; child: Node };

// ----------------------------------------------------------------------
// Pre-processing
// ----------------------------------------------------------------------

const FIELD_WRAPPERS: RegExp[] = [
  /\bTITLE-ABS-KEY\s*\(/gi,
  /\b(?:TITLE|ABS|KEY|ALL|SRCTITLE|AUTHKEY|INDEXTERMS)\s*\(/gi,
  /\b(?:TS|TI|AB|AK|ALL|SO|AU|TOPIC)\s*=\s*\(/gi,
];

const FIELD_TAGS: RegExp[] = [
  /"(?:All Metadata|Document Title|Abstract|Author Keywords|Index Terms|Full Text & Metadata|Full Text Only)"\s*:/gi,
  /\[(?:Title\/Abstract|Title|Abstract|Other Term|All Fields|tiab|tw|MeSH Terms?|mh)\]/gi,
];

function preprocess(raw: string): { text: string; warnings: string[] } {
  const warnings: string[] = [];
  let text = raw
    // curly and angled quotes to straight double quotes
    .replace(/[“”„‟«»]/g, '"')
    // curly single quotes to apostrophes
    .replace(/[‘’]/g, "'")
    // non breaking spaces and newlines to spaces
    .replace(/[ \r\n\t]/g, " ");

  let strippedField = false;
  for (const re of FIELD_WRAPPERS) {
    if (re.test(text)) {
      strippedField = true;
      text = text.replace(re, "(");
    }
  }
  for (const re of FIELD_TAGS) {
    if (re.test(text)) {
      strippedField = true;
      text = text.replace(re, " ");
    }
  }
  if (strippedField) {
    warnings.push(
      'Database field tags (like TITLE-ABS-KEY or TS=) were removed; use the "Search in" checkboxes to control fields instead.'
    );
  }
  return { text, warnings };
}

// ----------------------------------------------------------------------
// Tokenizer
// ----------------------------------------------------------------------

type Token =
  | { kind: "lparen" }
  | { kind: "rparen" }
  | { kind: "and" }
  | { kind: "or" }
  | { kind: "not" }
  | { kind: "term"; value: string };

const PROXIMITY = /^(?:W|NEAR|PRE|ADJ|N)\/?\d+$/i;

function tokenize(text: string, warnings: string[]): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < text.length) {
    const c = text[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === "(") {
      tokens.push({ kind: "lparen" });
      i++;
      continue;
    }
    if (c === ")") {
      tokens.push({ kind: "rparen" });
      i++;
      continue;
    }
    if (c === '"') {
      const end = text.indexOf('"', i + 1);
      if (end === -1) {
        warnings.push(
          "An opening quote was never closed; the rest of the string was treated as one phrase."
        );
        const value = text.slice(i + 1).trim();
        if (value) tokens.push({ kind: "term", value });
        break;
      }
      const value = text.slice(i + 1, end).trim();
      if (value) tokens.push({ kind: "term", value });
      i = end + 1;
      continue;
    }
    // Bare word: read until whitespace, paren, or quote.
    let j = i;
    while (j < text.length && !/[\s()"]/.test(text[j])) j++;
    const word = text.slice(i, j);
    i = j;
    const upper = word.toUpperCase();
    if (upper === "AND" || word === "&&" || word === "&") {
      tokens.push({ kind: "and" });
    } else if (upper === "OR" || word === "||" || word === "|") {
      tokens.push({ kind: "or" });
    } else if (upper === "NOT" || upper === "ANDNOT") {
      tokens.push({ kind: "not" });
    } else if (PROXIMITY.test(word)) {
      warnings.push(
        `Proximity operator "${word}" is database specific and was treated as AND; adjust manually if needed.`
      );
      tokens.push({ kind: "and" });
    } else if (word) {
      tokens.push({ kind: "term", value: word });
    }
  }
  return tokens;
}

// ----------------------------------------------------------------------
// Parser (precedence: NOT > AND > OR; implicit AND between adjacents)
// ----------------------------------------------------------------------

class Parser {
  private pos = 0;
  private impliedAnd = false;
  private tokens: Token[];
  private warnings: string[];

  constructor(tokens: Token[], warnings: string[]) {
    this.tokens = tokens;
    this.warnings = warnings;
  }

  private peek(): Token | null {
    return this.tokens[this.pos] ?? null;
  }
  private next(): Token | null {
    return this.tokens[this.pos++] ?? null;
  }

  parse(): Node | null {
    const node = this.parseOr();
    // Anything left over is an unbalanced closing paren or similar.
    while (this.peek()) {
      const t = this.next()!;
      if (t.kind === "rparen") {
        this.warnings.push(
          "An extra closing parenthesis was ignored (the pasted string's parentheses were unbalanced)."
        );
      } else {
        // Trailing content after a complete expression: treat as implicit AND.
        this.pos--;
        this.noteImplicitAnd();
        const rest = this.parseOr();
        if (node && rest) return { type: "and", children: [node, rest] };
        return node ?? rest;
      }
    }
    return node;
  }

  private noteImplicitAnd() {
    if (!this.impliedAnd) {
      this.impliedAnd = true;
      this.warnings.push(
        "Parts of the string had no operator between them; AND was assumed. Check the result."
      );
    }
  }

  private parseOr(): Node | null {
    let left = this.parseAnd();
    while (this.peek()?.kind === "or") {
      this.next();
      const right = this.parseAnd();
      if (!right) break;
      if (left === null) {
        left = right;
      } else if (left.type === "or") {
        left.children.push(right);
      } else {
        left = { type: "or", children: [left, right] };
      }
    }
    return left;
  }

  private parseAnd(): Node | null {
    let left = this.parseNot();
    for (;;) {
      const t = this.peek();
      if (!t) break;
      if (t.kind === "and") {
        this.next();
      } else if (t.kind === "not") {
        // "x NOT y" is standard WoS/PubMed syntax for AND NOT; no warning.
      } else if (t.kind === "term" || t.kind === "lparen") {
        // Implicit AND between adjacent operands.
        this.noteImplicitAnd();
      } else {
        break;
      }
      const right = this.parseNot();
      if (!right) break;
      if (left === null) {
        left = right;
      } else if (left.type === "and") {
        left.children.push(right);
      } else {
        left = { type: "and", children: [left, right] };
      }
    }
    return left;
  }

  private parseNot(): Node | null {
    if (this.peek()?.kind === "not") {
      this.next();
      const child = this.parseNot();
      if (!child) {
        this.warnings.push("A NOT had nothing after it and was ignored.");
        return null;
      }
      return { type: "not", child };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): Node | null {
    const t = this.peek();
    if (!t) return null;
    if (t.kind === "lparen") {
      this.next();
      const inner = this.parseOr();
      if (this.peek()?.kind === "rparen") {
        this.next();
      } else {
        this.warnings.push(
          "A closing parenthesis was missing and was added at the end."
        );
      }
      return inner;
    }
    if (t.kind === "term") {
      this.next();
      return { type: "term", value: t.value };
    }
    // Operator in an unexpected place (e.g. "AND AND", leading OR).
    if (t.kind === "and" || t.kind === "or") {
      this.next();
      this.warnings.push(
        "A stray AND/OR with nothing on one side was ignored."
      );
      return this.parsePrimary();
    }
    return null; // rparen: let the caller handle it
  }
}

// ----------------------------------------------------------------------
// AST -> concept groups (best effort flattening, with warnings)
// ----------------------------------------------------------------------

function collectTerms(node: Node): string[] {
  switch (node.type) {
    case "term":
      return [node.value];
    case "not":
      return collectTerms(node.child);
    default:
      return node.children.flatMap(collectTerms);
  }
}

/** True when the node is a term or a pure OR tree of terms. */
function isPureOr(node: Node): boolean {
  if (node.type === "term") return true;
  if (node.type === "or") return node.children.every(isPureOr);
  return false;
}

function dedupe(terms: string[], warnings: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  let dropped = 0;
  for (const t of terms) {
    const key = t.toLowerCase();
    if (seen.has(key)) {
      dropped++;
      continue;
    }
    seen.add(key);
    out.push(t);
  }
  if (dropped > 0) {
    warnings.push(
      `${dropped} duplicate term(s) inside a group were removed.`
    );
  }
  return out;
}

function toGroups(root: Node, warnings: string[]): SearchGroup[] {
  const topLevel: Node[] =
    root.type === "and" ? root.children : [root];

  // A top level OR that is not purely terms cannot be represented in the
  // AND-of-OR model; flag it clearly.
  if (root.type === "or" && !isPureOr(root)) {
    warnings.push(
      "The string's top level combines alternatives with OR in a way the group model cannot represent exactly; all terms were flattened into one group. Review carefully."
    );
    return [
      { terms: dedupe(collectTerms(root), warnings), not: false },
    ];
  }

  const groups: SearchGroup[] = [];
  topLevel.forEach((node, i) => {
    if (node.type === "not") {
      if (!isPureOr(node.child)) {
        warnings.push(
          `The NOT part (group ${i + 1}) contained nested AND/OR logic; its terms were flattened into one excluded list.`
        );
      }
      groups.push({
        terms: dedupe(collectTerms(node.child), warnings),
        not: true,
      });
      return;
    }
    if (!isPureOr(node)) {
      warnings.push(
        `Group ${i + 1} contained nested AND/NOT logic inside an OR; its terms were flattened into one OR list. Review that group.`
      );
    }
    groups.push({ terms: dedupe(collectTerms(node), warnings), not: false });
  });

  return groups.filter((g) => g.terms.length > 0);
}

// ----------------------------------------------------------------------
// Entry point
// ----------------------------------------------------------------------

export function parseSearchString(raw: string): ParseResult {
  if (!raw || !raw.trim()) {
    return { ok: false, error: "The pasted string is empty." };
  }
  const { text, warnings } = preprocess(raw);
  const tokens = tokenize(text, warnings);
  if (tokens.filter((t) => t.kind === "term").length === 0) {
    return {
      ok: false,
      error: "No search terms were found in the pasted string.",
    };
  }
  const parser = new Parser(tokens, warnings);
  const ast = parser.parse();
  if (!ast) {
    return {
      ok: false,
      error: "The string could not be parsed as a boolean search.",
    };
  }
  const groups = toGroups(ast, warnings);
  if (groups.length === 0 || groups.every((g) => g.not)) {
    return {
      ok: false,
      error:
        "Parsing produced no usable concept groups (only NOT terms or nothing).",
    };
  }
  // Deduplicate warnings while keeping their order.
  const seen = new Set<string>();
  const uniqueWarnings = warnings.filter((w) => {
    if (seen.has(w)) return false;
    seen.add(w);
    return true;
  });
  return { ok: true, groups, warnings: uniqueWarnings };
}
