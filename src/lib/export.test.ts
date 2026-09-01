import { describe, expect, it } from "vitest";
import type { RecordRow } from "./types";
import {
  bibtexKeyStem,
  buildBibtex,
  buildCsv,
  buildRis,
  escapeBibtex,
  slugify,
} from "./export";

function rec(overrides: Partial<RecordRow>): RecordRow {
  return {
    id: "r1",
    title: "A study",
    authors: null,
    year: null,
    venue: null,
    abstract: null,
    doi: null,
    url: null,
    ...overrides,
  } as RecordRow;
}

describe("slugify", () => {
  it("lowercases and dashes a project name", () => {
    expect(slugify("ABM Asylum: A Review!")).toBe("abm-asylum-a-review");
  });

  it("falls back when nothing survives", () => {
    expect(slugify("???")).toBe("simpleslr");
  });
});

describe("buildRis", () => {
  it("maps every populated field to its RIS tag", () => {
    const out = buildRis([
      rec({
        title: "Digital government maturity",
        authors: "Webster, J.; Watson, R.",
        year: 2002,
        venue: "MIS Quarterly",
        abstract: "Line one\nline two",
        doi: "10.1000/x",
        url: "https://example.org/paper",
      }),
    ]);
    const lines = out.split("\r\n");
    expect(lines[0]).toBe("TY  - JOUR");
    expect(lines).toContain("TI  - Digital government maturity");
    expect(lines).toContain("AU  - Webster, J.");
    expect(lines).toContain("AU  - Watson, R.");
    expect(lines).toContain("PY  - 2002");
    expect(lines).toContain("T2  - MIS Quarterly");
    expect(lines).toContain("AB  - Line one line two");
    expect(lines).toContain("DO  - 10.1000/x");
    expect(lines).toContain("UR  - https://example.org/paper");
    expect(lines).toContain("ER  - ");
  });

  it("omits tags for missing fields and still terminates the record", () => {
    const out = buildRis([rec({ title: "Bare" })]);
    expect(out).not.toContain("AU  -");
    expect(out).not.toContain("PY  -");
    expect(out).toContain("ER  - ");
  });

  it("emits one record block per input row", () => {
    const out = buildRis([rec({ title: "One" }), rec({ id: "r2", title: "Two" })]);
    expect(out.match(/^TY {2}- JOUR$/gm)).toHaveLength(2);
    expect(out.match(/^ER {2}- $/gm)).toHaveLength(2);
  });
});

describe("escapeBibtex", () => {
  it("escapes every LaTeX special character once", () => {
    expect(escapeBibtex("A & B 100% #1 $5 x_y")).toBe(
      "A \\& B 100\\% \\#1 \\$5 x\\_y"
    );
    expect(escapeBibtex("{x}")).toBe("\\{x\\}");
    expect(escapeBibtex("a~b^c")).toBe("a\\textasciitilde{}b\\textasciicircum{}c");
    expect(escapeBibtex("a\\b")).toBe("a\\textbackslash{}b");
  });

  it("never re-escapes its own output characters", () => {
    // The braces introduced by \textbackslash{} must survive as-is.
    expect(escapeBibtex("\\")).toBe("\\textbackslash{}");
  });

  it("collapses newlines to spaces", () => {
    expect(escapeBibtex("one\n  two")).toBe("one two");
  });
});

describe("bibtexKeyStem", () => {
  it("takes the surname before a comma", () => {
    expect(bibtexKeyStem("Webster, J.; Watson, R.")).toBe("webster");
  });

  it("takes the last word of a given-first name", () => {
    expect(bibtexKeyStem("Jane Webster; Richard Watson")).toBe("webster");
  });

  it("strips diacritics and non-alphanumerics", () => {
    expect(bibtexKeyStem("Müller-Lüdenscheidt, K.")).toBe("mullerludenscheidt");
  });

  it("falls back for empty authors", () => {
    expect(bibtexKeyStem(null)).toBe("record");
    expect(bibtexKeyStem("   ")).toBe("record");
  });
});

describe("buildBibtex", () => {
  it("builds an @article with author names joined by and", () => {
    const out = buildBibtex([
      rec({
        title: "E-government adoption",
        authors: "Webster, J.; Watson, R.",
        year: 2002,
        venue: "MIS Quarterly",
        doi: "10.1000/x",
        url: "https://example.org",
        abstract: "Short abstract.",
      }),
    ]);
    expect(out).toContain("@article{webster2002,");
    expect(out).toContain("title = {E-government adoption}");
    expect(out).toContain("author = {Webster, J. and Watson, R.}");
    expect(out).toContain("year = {2002}");
    expect(out).toContain("journal = {MIS Quarterly}");
    expect(out).toContain("doi = {10.1000/x}");
    expect(out).toContain("url = {https://example.org}");
    expect(out).toContain("abstract = {Short abstract.}");
  });

  it("disambiguates colliding citation keys with letter suffixes", () => {
    const out = buildBibtex([
      rec({ title: "First", authors: "Smith, A.", year: 2020 }),
      rec({ id: "r2", title: "Second", authors: "Smith, B.", year: 2020 }),
      rec({ id: "r3", title: "Third", authors: "Smith, C.", year: 2020 }),
    ]);
    expect(out).toContain("@article{smith2020,");
    expect(out).toContain("@article{smith2020a,");
    expect(out).toContain("@article{smith2020b,");
  });

  it("escapes LaTeX specials inside field values", () => {
    const out = buildBibtex([
      rec({ title: "Q&A systems at 100% scale", authors: "Smith, A._B." }),
    ]);
    expect(out).toContain("title = {Q\\&A systems at 100\\% scale}");
    expect(out).toContain("author = {Smith, A.\\_B.}");
  });

  it("omits fields that are missing", () => {
    const out = buildBibtex([rec({ title: "Bare" })]);
    expect(out).not.toContain("author =");
    expect(out).not.toContain("year =");
    expect(out).not.toContain("journal =");
  });
});

describe("buildCsv", () => {
  it("quotes only cells that need it and doubles inner quotes", () => {
    const out = buildCsv(
      ["a", "b"],
      [
        ["plain", 'say "hi", ok'],
        [null, "line\nbreak"],
      ]
    );
    const lines = out.split("\r\n");
    expect(lines[0]).toBe("a,b");
    expect(lines[1]).toBe('plain,"say ""hi"", ok"');
    expect(lines[2]).toBe(',"line\nbreak"');
  });
});
