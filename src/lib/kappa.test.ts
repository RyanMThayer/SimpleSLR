import { describe, expect, it } from "vitest";
import type { Decision } from "./types";
import type { DecisionLite } from "./kappa";
import {
  cohenKappa,
  fleissKappa,
  kappaPhrase,
  landisKoch,
  stageKappa,
} from "./kappa";

function dec(
  record: string,
  user: string,
  decision: Decision,
  at = "2026-01-01T10:00:00Z"
): DecisionLite {
  return { record_id: record, decided_by: user, decision, decided_at: at };
}

describe("landisKoch", () => {
  it("maps kappa values to the published bands", () => {
    expect(landisKoch(-0.1)).toBe("poor");
    expect(landisKoch(0.1)).toBe("slight");
    expect(landisKoch(0.3)).toBe("fair");
    expect(landisKoch(0.5)).toBe("moderate");
    expect(landisKoch(0.7)).toBe("substantial");
    expect(landisKoch(0.9)).toBe("almost perfect");
  });
});

describe("cohenKappa", () => {
  it("matches a hand-computed 2x2 table", () => {
    // 10 both include, 5 both exclude, 3 A-inc/B-exc, 2 A-exc/B-inc.
    // po = 0.75, pe = 0.65*0.6 + 0.35*0.4 = 0.53, kappa = 0.22/0.47.
    const pairs: [Decision, Decision][] = [
      ...Array<[Decision, Decision]>(10).fill(["include", "include"]),
      ...Array<[Decision, Decision]>(5).fill(["exclude", "exclude"]),
      ...Array<[Decision, Decision]>(3).fill(["include", "exclude"]),
      ...Array<[Decision, Decision]>(2).fill(["exclude", "include"]),
    ];
    expect(cohenKappa(pairs)).toBeCloseTo(0.22 / 0.47, 6);
  });

  it("is 1 for perfect agreement with variation", () => {
    expect(
      cohenKappa([
        ["include", "include"],
        ["exclude", "exclude"],
      ])
    ).toBe(1);
  });

  it("is undefined when both raters never vary", () => {
    expect(
      cohenKappa([
        ["exclude", "exclude"],
        ["exclude", "exclude"],
      ])
    ).toBeNull();
    expect(cohenKappa([])).toBeNull();
  });
});

describe("fleissKappa", () => {
  it("matches a hand-computed two-rating example", () => {
    // Rows [inc, exc]: pBar = 0.75, peBar = 0.53125.
    const rows: [number, number][] = [
      [2, 0],
      [0, 2],
      [2, 0],
      [1, 1],
    ];
    expect(fleissKappa(rows)).toBeCloseTo(0.21875 / 0.46875, 6);
  });

  it("is undefined without variation or without subjects", () => {
    expect(
      fleissKappa([
        [0, 2],
        [0, 2],
      ])
    ).toBeNull();
    expect(fleissKappa([])).toBeNull();
  });
});

describe("stageKappa", () => {
  it("uses Cohen's kappa for exactly two reviewers", () => {
    const decisions = [
      dec("r1", "u1", "include"),
      dec("r1", "u2", "include"),
      dec("r2", "u1", "exclude"),
      dec("r2", "u2", "exclude"),
      dec("r3", "u1", "include"),
      dec("r3", "u2", "exclude"),
      dec("r4", "u1", "exclude"),
      dec("r4", "u2", "include"),
    ];
    const r = stageKappa(decisions)!;
    expect(r.statistic).toBe("cohen");
    expect(r.records).toBe(4);
    expect(r.raters).toBe(2);
    // po = 0.5, pe = 0.5 -> kappa = 0.
    expect(r.value).toBeCloseTo(0, 6);
  });

  it("ignores single-screened records and needs at least two dual ones", () => {
    const decisions = [
      dec("r1", "u1", "include"),
      dec("r2", "u1", "include"),
      dec("r2", "u2", "include"),
    ];
    expect(stageKappa(decisions)).toBeNull();
  });

  it("keeps only each reviewer's latest opinion", () => {
    const decisions = [
      dec("r1", "u1", "include", "2026-01-01T10:00:00Z"),
      dec("r1", "u1", "exclude", "2026-01-02T10:00:00Z"),
      dec("r1", "u2", "exclude"),
      dec("r2", "u1", "include"),
      dec("r2", "u2", "include"),
    ];
    const r = stageKappa(decisions)!;
    // With u1's changed opinion, both records agree perfectly.
    expect(r.value).toBe(1);
  });

  it("switches to Fleiss' kappa when more than two reviewers contributed", () => {
    const decisions = [
      dec("r1", "u1", "include"),
      dec("r1", "u2", "include"),
      dec("r2", "u2", "exclude"),
      dec("r2", "u3", "exclude"),
      dec("r3", "u1", "include"),
      dec("r3", "u3", "exclude"),
    ];
    const r = stageKappa(decisions)!;
    expect(r.statistic).toBe("fleiss");
    expect(r.raters).toBe(3);
    expect(r.records).toBe(3);
  });

  it("restricts Fleiss to the modal opinion count", () => {
    const decisions = [
      // Two records with 2 opinions, one with 3.
      dec("r1", "u1", "include"),
      dec("r1", "u2", "include"),
      dec("r2", "u2", "exclude"),
      dec("r2", "u3", "include"),
      dec("r3", "u1", "include"),
      dec("r3", "u2", "include"),
      dec("r3", "u3", "exclude"),
    ];
    const r = stageKappa(decisions)!;
    expect(r.statistic).toBe("fleiss");
    expect(r.records).toBe(2);
  });

  it("returns null for empty input", () => {
    expect(stageKappa([])).toBeNull();
  });
});

describe("kappaPhrase", () => {
  it("names the statistic, band, and scope", () => {
    expect(
      kappaPhrase({ statistic: "cohen", value: 0.72, records: 180, raters: 2 })
    ).toBe(
      "Cohen's kappa = 0.72 (substantial agreement, Landis and Koch) · 180 records dual screened by 2 reviewers"
    );
  });

  it("says so when the statistic is undefined", () => {
    expect(
      kappaPhrase({ statistic: "fleiss", value: null, records: 12, raters: 3 })
    ).toContain("not computable");
  });
});
