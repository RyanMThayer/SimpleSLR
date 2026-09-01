import { describe, expect, it } from "vitest";
import type { ProjectDatabase } from "./types";
import type { FactSheetInput, SummaryArm, SummaryCounts } from "./prismaSummary";
import {
  buildPrismaFactSheet,
  factSheetText,
  formatLongDate,
  listJoin,
  plural,
} from "./prismaSummary";

function arm(overrides: Partial<SummaryArm> = {}): SummaryArm {
  return {
    identified: 0,
    backward: 0,
    forward: 0,
    duplicates: 0,
    autoExcluded: 0,
    screened: 0,
    taExcluded: 0,
    sought: 0,
    notRetrieved: 0,
    assessed: 0,
    ftExcluded: 0,
    ftExcludedByReason: [],
    ftIncluded: 0,
    ...overrides,
  };
}

function counts(overrides: Partial<SummaryCounts> = {}): SummaryCounts {
  return {
    identified: 0,
    db: arm(),
    other: arm(),
    perSource: [],
    taUndecided: 0,
    taConflicts: 0,
    ftUndecided: 0,
    ftIncluded: 0,
    ...overrides,
  };
}

function db(overrides: Partial<ProjectDatabase> & { name: string }): ProjectDatabase {
  return {
    id: `db-${overrides.name}`,
    project_id: "p1",
    kind: "standard",
    enabled: true,
    raw_hit_count: null,
    searched_on: null,
    notes: null,
    position: 0,
    created_at: "2026-01-01",
    ...overrides,
  } as ProjectDatabase;
}

function input(overrides: Partial<FactSheetInput> = {}): FactSheetInput {
  return {
    searchConfig: null,
    databases: [],
    counts: counts(),
    memberCount: 1,
    asOf: "September 1, 2026",
    ...overrides,
  };
}

describe("formatLongDate", () => {
  it("renders an ISO date without timezone surprises", () => {
    expect(formatLongDate("2026-06-17")).toBe("June 17, 2026");
    expect(formatLongDate("2026-01-01T10:00:00Z")).toBe("January 1, 2026");
  });

  it("passes through unparseable input and nulls", () => {
    expect(formatLongDate("June 2026")).toBe("June 2026");
    expect(formatLongDate(null)).toBeNull();
  });
});

describe("listJoin and plural", () => {
  it("joins with an Oxford comma", () => {
    expect(listJoin(["A"])).toBe("A");
    expect(listJoin(["A", "B"])).toBe("A and B");
    expect(listJoin(["A", "B", "C"])).toBe("A, B, and C");
  });

  it("pluralizes counts", () => {
    expect(plural(1, "record")).toBe("1 record");
    expect(plural(3, "record")).toBe("3 records");
    expect(plural(2, "hit")).toBe("2 hits");
  });
});

describe("buildPrismaFactSheet", () => {
  it("always emits the five core sections in checklist order", () => {
    const sections = buildPrismaFactSheet(input());
    expect(sections.map((s) => s.item)).toEqual([
      "Item 5",
      "Item 6",
      "Item 7",
      "Item 8",
      "Item 16a",
      "Item 16a",
    ]);
    expect(sections[0].title).toBe("Eligibility criteria");
    expect(sections[sections.length - 1].title).toBe("Total");
  });

  it("marks unrecorded criteria with bracketed gaps, never invented text", () => {
    const rows = buildPrismaFactSheet(input())[0].rows;
    expect(rows[0].value).toBe("[not recorded yet]");
    expect(rows[1].value).toBe("[no exclusion reasons recorded yet]");
  });

  it("numbers exclusion reasons E1..En in position order", () => {
    const rows = buildPrismaFactSheet(
      input({
        inclusionCriteria: "Peer reviewed e-government studies.",
        reasonLabels: ["Not e-government", "No empirical data"],
      })
    )[0].rows;
    expect(rows[0].value).toBe("Peer reviewed e-government studies.");
    expect(rows[1].value).toBe(
      "E1: Not e-government; E2: No empirical data"
    );
  });

  it("reports per-source hits, imports, and search dates", () => {
    const sections = buildPrismaFactSheet(
      input({
        databases: [db({ name: "Scopus", searched_on: "2026-05-02", raw_hit_count: 431 })],
        counts: counts({
          perSource: [
            { name: "Scopus", imported: 200, rawHits: 431, snowball: false },
          ],
        }),
      })
    );
    const src = sections.find((s) => s.title === "Information sources")!;
    expect(src.rows[0].label).toBe("Scopus");
    expect(src.rows[0].value).toBe("searched May 2, 2026 · 431 hits, 200 imported");
  });

  it("adds the citation searching source row only when snowballing found records", () => {
    const without = buildPrismaFactSheet(input());
    expect(
      without
        .find((s) => s.title === "Information sources")!
        .rows.some((r) => r.label === "Citation searching")
    ).toBe(false);

    const withSnowball = buildPrismaFactSheet(
      input({
        counts: counts({
          other: arm({ identified: 12, backward: 8, forward: 4 }),
        }),
      })
    );
    const row = withSnowball
      .find((s) => s.title === "Information sources")!
      .rows.find((r) => r.label === "Citation searching")!;
    expect(row.value).toContain("12 records");
    expect(row.value).toContain("8 from reference lists");
    expect(row.value).toContain("4 from citing works");
  });

  it("shows the automated prescreen line only when it removed records", () => {
    const off = buildPrismaFactSheet(input());
    expect(
      off
        .find((s) => s.title === "Selection process")!
        .rows.some((r) => r.label === "Automated prescreen")
    ).toBe(false);

    const on = buildPrismaFactSheet(
      input({ counts: counts({ db: arm({ autoExcluded: 30 }) }) })
    );
    const row = on
      .find((s) => s.title === "Selection process")!
      .rows.find((r) => r.label === "Automated prescreen")!;
    expect(row.value).toContain("30 records removed before screening");
    expect(row.value).toContain("temperature 0");
    expect(row.value).toContain("unanimous votes");
  });

  it("notes blinding only under dual screening", () => {
    const single = buildPrismaFactSheet(input());
    expect(
      single
        .find((s) => s.title === "Selection process")!
        .rows.some((r) => r.label === "Blinding")
    ).toBe(false);

    const dual = buildPrismaFactSheet(input({ requiredTa: 2, requiredFt: 2 }));
    expect(
      dual
        .find((s) => s.title === "Selection process")!
        .rows.some((r) => r.label === "Blinding")
    ).toBe(true);
  });

  it("adds the citation-searching arm and splits the total when snowballing contributed", () => {
    const sections = buildPrismaFactSheet(
      input({
        counts: counts({
          db: arm({ ftIncluded: 20 }),
          other: arm({ identified: 12, ftIncluded: 5 }),
          ftIncluded: 25,
        }),
      })
    );
    const arms = sections.filter((s) => s.item === "Item 16a");
    expect(arms.map((s) => s.title)).toEqual([
      "Study selection · identified via databases",
      "Study selection · identified via citation searching",
      "Total",
    ]);
    expect(arms[2].rows[0].value).toBe(
      "25 (20 via databases, 5 via citation searching)"
    );
  });

  it("carries a live-snapshot note while screening is unfinished, and drops it when done", () => {
    const inProgress = buildPrismaFactSheet(
      input({ counts: counts({ taUndecided: 7, taConflicts: 1 }) })
    );
    const total = inProgress[inProgress.length - 1];
    expect(total.note).toContain("still in progress as of September 1, 2026");
    expect(total.note).toContain("7 records undecided");

    const done = buildPrismaFactSheet(input());
    expect(done[done.length - 1].note).toBeUndefined();
  });

  it("breaks full text exclusions down by reason", () => {
    const sections = buildPrismaFactSheet(
      input({
        counts: counts({
          db: arm({
            ftExcluded: 5,
            ftExcludedByReason: [
              { label: "Not e-government", count: 3 },
              { label: "No empirical data", count: 2 },
            ],
          }),
        }),
      })
    );
    const dbArm = sections.find(
      (s) => s.title === "Study selection · identified via databases"
    )!;
    const row = dbArm.rows.find((r) => r.label === "Reports excluded at full text")!;
    expect(row.value).toBe(
      "5 (Not e-government, n = 3; No empirical data, n = 2)"
    );
  });
});

describe("factSheetText", () => {
  it("renders sections as indented label-value lines", () => {
    const text = factSheetText([
      {
        item: "Item 5",
        title: "Eligibility criteria",
        rows: [{ label: "Inclusion criteria", value: "X" }],
        note: "[note]",
      },
    ]);
    expect(text).toBe("Item 5 · Eligibility criteria\n  Inclusion criteria: X\n  [note]");
  });
});
