import { describe, expect, it } from "vitest";
import type { BatchLite, RecordLite, SnowballEdge, SnowballNode } from "./snowballGraph";
import {
  authorEntries,
  buildSnowballGraph,
  flowGenerations,
  shortLabel,
  surnameOf,
} from "./snowballGraph";

function makeRec(overrides: Partial<RecordLite> & { id: string }): RecordLite {
  return {
    title: `Paper ${overrides.id}`,
    authors: null,
    year: 2020,
    status: "active",
    batch_id: null,
    ...overrides,
  };
}

const SNOWBALL_BATCH: BatchLite = {
  id: "b-snow",
  filename: null,
  origin: "snowball:openalex",
};
const IMPORT_BATCH: BatchLite = { id: "b-import", filename: "scopus.ris", origin: "import" };

function graphInput(records: RecordLite[], links: { record_id: string; seed_record_id: string; direction: string }[]) {
  return {
    links,
    records: new Map(records.map((r) => [r.id, r])),
    batches: new Map<string, BatchLite>([
      [SNOWBALL_BATCH.id, SNOWBALL_BATCH],
      [IMPORT_BATCH.id, IMPORT_BATCH],
    ]),
    statusOf: () => "screening" as const,
  };
}

describe("authorEntries", () => {
  it("splits semicolon separated lists", () => {
    expect(authorEntries("Webster, J.; Watson, R.")).toEqual([
      "Webster, J.",
      "Watson, R.",
    ]);
  });

  it("stitches surname-first comma pairs back together", () => {
    expect(authorEntries("Webster, J., Watson, R.")).toEqual([
      "Webster, J.",
      "Watson, R.",
    ]);
  });

  it("splits and-separated full names", () => {
    expect(authorEntries("Jane Webster and Richard Watson")).toEqual([
      "Jane Webster",
      "Richard Watson",
    ]);
  });
});

describe("surnameOf", () => {
  it("reads the surname before a comma", () => {
    expect(surnameOf("Webster, J.")).toBe("Webster");
  });

  it("takes the last full word of a given-first name", () => {
    expect(surnameOf("Jane Webster")).toBe("Webster");
  });

  it("skips initials and generational suffixes", () => {
    expect(surnameOf("Martin L. King Jr.")).toBe("King");
  });
});

describe("shortLabel", () => {
  it("formats one, two, and many authors", () => {
    expect(shortLabel("Webster, J.", 2002, "t")).toBe("Webster 2002");
    expect(shortLabel("Webster, J.; Watson, R.", 2002, "t")).toBe(
      "Webster and Watson 2002"
    );
    expect(shortLabel("A One; B Two; C Three", 2005, "t")).toBe("One et al. 2005");
  });

  it("falls back to the title's first words without authors", () => {
    expect(shortLabel(null, null, "Digital government maturity models")).toBe(
      "Digital government"
    );
  });
});

describe("buildSnowballGraph provenance rule", () => {
  it("draws an edge only when the target was created by a snowball batch", () => {
    const seed = makeRec({ id: "seed" });
    const found = makeRec({ id: "found", batch_id: SNOWBALL_BATCH.id });
    const { nodes, edges } = buildSnowballGraph(
      graphInput(
        [seed, found],
        [{ record_id: "found", seed_record_id: "seed", direction: "backward" }]
      )
    );
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      seedId: "seed",
      recordId: "found",
      direction: "backward",
    });
    const ids = nodes.map((n: SnowballNode) => n.id).sort();
    expect(ids).toEqual(["found", "seed"]);
  });

  it("draws nothing for a citation landing on another seed (seed-to-seed rediscovery)", () => {
    const seedA = makeRec({ id: "seedA", batch_id: IMPORT_BATCH.id });
    const seedB = makeRec({ id: "seedB", batch_id: IMPORT_BATCH.id });
    const { nodes, edges } = buildSnowballGraph(
      graphInput(
        [seedA, seedB],
        [{ record_id: "seedB", seed_record_id: "seedA", direction: "backward" }]
      )
    );
    expect(edges).toHaveLength(0);
    // The seed that was snowballed FROM still lands on the map.
    expect(nodes.map((n: SnowballNode) => n.id)).toEqual(["seedA"]);
  });

  it("folds a duplicate rediscovery onto its keeper so cross-seed overlap survives", () => {
    const seedA = makeRec({ id: "seedA" });
    const seedB = makeRec({ id: "seedB" });
    const keeper = makeRec({ id: "keeper", batch_id: SNOWBALL_BATCH.id });
    const dupe = makeRec({
      id: "dupe",
      status: "duplicate",
      duplicate_of: "keeper",
      batch_id: SNOWBALL_BATCH.id,
    });
    const { edges } = buildSnowballGraph(
      graphInput(
        [seedA, seedB, keeper, dupe],
        [
          { record_id: "keeper", seed_record_id: "seedA", direction: "backward" },
          // Second seed rediscovers the same paper as a duplicate row.
          { record_id: "dupe", seed_record_id: "seedB", direction: "backward" },
        ]
      )
    );
    expect(edges).toHaveLength(2);
    expect(edges.map((e: SnowballEdge) => `${e.seedId}->${e.recordId}`).sort()).toEqual([
      "seedA->keeper",
      "seedB->keeper",
    ]);
  });

  it("deduplicates repeated identical links", () => {
    const seed = makeRec({ id: "seed" });
    const found = makeRec({ id: "found", batch_id: SNOWBALL_BATCH.id });
    const { edges } = buildSnowballGraph(
      graphInput(
        [seed, found],
        [
          { record_id: "found", seed_record_id: "seed", direction: "forward" },
          { record_id: "found", seed_record_id: "seed", direction: "forward" },
        ]
      )
    );
    expect(edges).toHaveLength(1);
  });
});

describe("flowGenerations", () => {
  function node(id: string, snowballed: boolean): SnowballNode {
    return {
      id,
      title: id,
      authors: null,
      year: null,
      isSeed: !snowballed,
      status: "screening",
      taIncluded: true,
      snowballed,
      source: snowballed ? "openalex" : "screening",
      degree: 0,
      label: id,
    };
  }

  function edge(seedId: string, recordId: string): SnowballEdge {
    return {
      id: `${seedId}:${recordId}:backward`,
      source: seedId,
      target: recordId,
      seedId,
      recordId,
      direction: "backward",
    };
  }

  it("puts original seeds in round 1 and found papers one round after their first finder", () => {
    const nodes = [node("seed", false), node("found", true), node("deep", true)];
    const edges = [edge("seed", "found"), edge("found", "deep")];
    const { genOf, finderOf } = flowGenerations(nodes, edges);
    expect(genOf.get("seed")).toBe(1);
    expect(genOf.get("found")).toBe(2);
    expect(genOf.get("deep")).toBe(3);
    expect(finderOf.get("deep")).toBe("found");
  });

  it("attributes a paper to its FIRST finder when two seeds surface it", () => {
    const nodes = [node("s1", false), node("s2", false), node("found", true)];
    const edges = [edge("s1", "found"), edge("s2", "found")];
    const { finderOf, genOf } = flowGenerations(nodes, edges);
    expect(finderOf.get("found")).toBe("s1");
    expect(genOf.get("found")).toBe(2);
  });

  it("caps runaway chains at 6 rounds", () => {
    const nodes = [node("s", false)];
    const edges: SnowballEdge[] = [];
    let prev = "s";
    for (let i = 1; i <= 10; i++) {
      const id = `n${i}`;
      nodes.push(node(id, true));
      edges.push(edge(prev, id));
      prev = id;
    }
    const { genOf } = flowGenerations(nodes, edges);
    const max = Math.max(...[...genOf.values()]);
    expect(max).toBe(6);
    expect(genOf.get("s")).toBe(1);
    // Rounds grow one per hop until the cap, then hold there.
    expect(genOf.get("n1")).toBe(2);
    expect(genOf.get("n4")).toBe(5);
    expect(genOf.get("n5")).toBe(6);
    expect(genOf.get("n10")).toBe(6);
  });
});
