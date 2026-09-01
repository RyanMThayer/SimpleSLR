import { describe, expect, it } from "vitest";
import {
  REFERENCE_GROUPS,
  formatReference,
  refById,
} from "./references";

const all = REFERENCE_GROUPS.flatMap((g) => g.refs);

describe("reference data", () => {
  it("has unique, anchor-safe ids", () => {
    const ids = all.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9]+$/);
  });

  it("gives every reference the fields the page renders", () => {
    for (const r of all) {
      expect(r.cite.length).toBeGreaterThan(0);
      expect(r.authors.length).toBeGreaterThan(0);
      expect(r.title.length).toBeGreaterThan(0);
      expect(r.venue.length).toBeGreaterThan(0);
      expect(r.note.length).toBeGreaterThan(0);
      expect(r.year).toBeGreaterThan(1950);
      expect(r.year).toBeLessThanOrEqual(new Date().getFullYear());
    }
  });

  it("has well-formed DOIs and https URLs where present", () => {
    for (const r of all) {
      if (r.doi) expect(r.doi).toMatch(/^10\.\d{4,}\//);
      if (r.url) expect(r.url).toMatch(/^https:\/\//);
    }
  });

  it("keeps every group non-empty", () => {
    for (const g of REFERENCE_GROUPS) {
      expect(g.refs.length).toBeGreaterThan(0);
    }
  });

  it("resolves the ids the Report page cites", () => {
    for (const id of [
      "page2021",
      "page2021ee",
      "rethlefsen2021",
      "websterwatson2002",
      "vombrocke2009",
      "richardson1995",
      "fain2025",
      "wohlin2014",
      "waffenschmidt2019",
      "cohen1960",
      "fleiss1971",
      "landiskoch1977",
      "khraisha2024",
    ]) {
      expect(refById(id).id).toBe(id);
    }
    expect(() => refById("nope")).toThrow();
  });

  it("keeps sources the tool does not actually implement OFF the page", () => {
    // Audited out 2026-09-01: canonical literature, but no feature
    // traces to them, and competitor tool papers are not methodology.
    for (const dropped of [
      "kitchenham2007",
      "okoli2015",
      "levyellis2006",
      "gusenbauer2020",
      "ouzzani2016",
      "vandeschoot2021",
    ]) {
      expect(all.some((r) => r.id === dropped)).toBe(false);
    }
  });

  it("formats a reference as one citation line", () => {
    expect(formatReference(refById("cohen1960"))).toBe(
      "Cohen J (1960). A coefficient of agreement for nominal scales. Educational and Psychological Measurement 20(1):37–46. doi:10.1177/001316446002000104"
    );
  });
});
