/**
 * The methodological literature SimpleSLR is built on. One source of
 * truth: the public /references page renders these groups, and the
 * Report page's methodology blocks cite them by id so a review team
 * can carry the citations into their manuscript.
 */

export type Reference = {
  /** Anchor on /references and the citation key used by the Report. */
  id: string;
  /** Short in-text label, e.g. "Webster and Watson 2002". */
  cite: string;
  authors: string;
  year: number;
  title: string;
  venue: string;
  doi?: string;
  url?: string;
  /** What this source grounds inside SimpleSLR. */
  note: string;
};

export type ReferenceGroup = { title: string; refs: Reference[] };

export const REFERENCE_GROUPS: ReferenceGroup[] = [
  {
    title: "Reporting and process guidelines",
    refs: [
      {
        id: "page2021",
        cite: "Page et al. 2021",
        authors:
          "Page MJ, McKenzie JE, Bossuyt PM, Boutron I, Hoffmann TC, Mulrow CD, et al.",
        year: 2021,
        title:
          "The PRISMA 2020 statement: an updated guideline for reporting systematic reviews",
        venue: "BMJ 372:n71",
        doi: "10.1136/bmj.n71",
        note: "The reporting standard behind the flow diagram, the fact sheet's checklist items, and the two-stage screening structure.",
      },
      {
        id: "page2021ee",
        cite: "Page et al. 2021 (E&E)",
        authors:
          "Page MJ, Moher D, Bossuyt PM, Boutron I, Hoffmann TC, Mulrow CD, et al.",
        year: 2021,
        title:
          "PRISMA 2020 explanation and elaboration: updated guidance and exemplars for reporting systematic reviews",
        venue: "BMJ 372:n160",
        doi: "10.1136/bmj.n160",
        note: "Item-by-item guidance the Report page's fact sheet rows follow.",
      },
      {
        id: "rethlefsen2021",
        cite: "Rethlefsen et al. 2021",
        authors:
          "Rethlefsen ML, Kirtley S, Waffenschmidt S, Ayala AP, Moher D, Page MJ, Koffel JB",
        year: 2021,
        title:
          "PRISMA-S: an extension to the PRISMA statement for reporting literature searches in systematic reviews",
        venue: "Systematic Reviews 10:39",
        doi: "10.1186/s13643-020-01542-z",
        note: "Why Discovery records the exact search string, fields, limits, per-database dates and hit counts.",
      },
    ],
  },
  {
    title: "Literature reviews in information systems",
    refs: [
      {
        id: "websterwatson2002",
        cite: "Webster and Watson 2002",
        authors: "Webster J, Watson RT",
        year: 2002,
        title:
          "Analyzing the past to prepare for the future: writing a literature review",
        venue: "MIS Quarterly 26(2):xiii–xxiii",
        note: "The concept matrix at the heart of the Synthesize page, and backward/forward citation searching.",
      },
      {
        id: "vombrocke2009",
        cite: "vom Brocke et al. 2009",
        authors:
          "vom Brocke J, Simons A, Niehaves B, Riemer K, Plattfaut R, Cleven A",
        year: 2009,
        title:
          "Reconstructing the giant: on the importance of rigour in documenting the literature search process",
        venue:
          "Proceedings of the 17th European Conference on Information Systems (ECIS), 2206–2217",
        url: "https://aisel.aisnet.org/ecis2009/161/",
        note: "The case for documenting the search so it can be reconstructed; the reason everything here is logged and exportable.",
      },
    ],
  },
  {
    title: "Framing the question",
    refs: [
      {
        id: "richardson1995",
        cite: "Richardson et al. 1995",
        authors: "Richardson WS, Wilson MC, Nishikawa J, Hayward RS",
        year: 1995,
        title:
          "The well-built clinical question: a key to evidence-based decisions",
        venue: "ACP Journal Club 123(3):A12–A13",
        note: "Origin of the PICO scheme behind the optional PICOT framing of the research question.",
      },
      {
        id: "fain2025",
        cite: "Fain 2025",
        authors: "Fain JA",
        year: 2025,
        title: "How to write a systematic literature review",
        venue: "Sage Perspectives, April 3, 2025",
        url: "https://www.sagepub.com/explore-our-content/blogs/posts/sage-perspectives/2025/04/03/how-to-write-a-systematic-literature-review",
        note: "A current walkthrough recommending PICOT framing, a priori criteria, and matrix tables for extraction.",
      },
    ],
  },
  {
    title: "Citation searching",
    refs: [
      {
        id: "wohlin2014",
        cite: "Wohlin 2014",
        authors: "Wohlin C",
        year: 2014,
        title:
          "Guidelines for snowballing in systematic literature studies and a replication in software engineering",
        venue:
          "Proceedings of the 18th International Conference on Evaluation and Assessment in Software Engineering (EASE)",
        doi: "10.1145/2601248.2601268",
        note: "The backward/forward snowballing procedure the Snowball page records seed by seed with provenance. Wohlin iterates until no new papers surface; the tool records each round and leaves the stopping decision to the review team.",
      },
    ],
  },
  {
    title: "Screening and reliability",
    refs: [
      {
        id: "waffenschmidt2019",
        cite: "Waffenschmidt et al. 2019",
        authors: "Waffenschmidt S, Knelangen M, Sieben W, Bühn S, Pieper D",
        year: 2019,
        title:
          "Single screening versus conventional double screening for study selection in systematic reviews: a methodological systematic review",
        venue: "BMC Medical Research Methodology 19:132",
        doi: "10.1186/s12874-019-0782-0",
        note: "The evidence that single screening misses studies; why independent dual screening is a first-class mode.",
      },
      {
        id: "cohen1960",
        cite: "Cohen 1960",
        authors: "Cohen J",
        year: 1960,
        title: "A coefficient of agreement for nominal scales",
        venue: "Educational and Psychological Measurement 20(1):37–46",
        doi: "10.1177/001316446002000104",
        note: "Cohen's kappa, reported for two-reviewer screening.",
      },
      {
        id: "fleiss1971",
        cite: "Fleiss 1971",
        authors: "Fleiss JL",
        year: 1971,
        title: "Measuring nominal scale agreement among many raters",
        venue: "Psychological Bulletin 76(5):378–382",
        doi: "10.1037/h0031619",
        note: "Fleiss' kappa, reported when more than two reviewers screen.",
      },
      {
        id: "landiskoch1977",
        cite: "Landis and Koch 1977",
        authors: "Landis JR, Koch GG",
        year: 1977,
        title: "The measurement of observer agreement for categorical data",
        venue: "Biometrics 33(1):159–174",
        doi: "10.2307/2529310",
        note: "The interpretation bands (slight to almost perfect) shown beside kappa values.",
      },
    ],
  },
  {
    title: "Automated screening",
    refs: [
      {
        id: "khraisha2024",
        cite: "Khraisha et al. 2024",
        authors: "Khraisha Q, Put S, Kappenberg J, Warraitch A, Hadfield K",
        year: 2024,
        title:
          "Can large language models replace humans in systematic reviews? Evaluating GPT-4's efficacy in screening and extracting data from peer-reviewed and grey literature in multiple languages",
        venue: "Research Synthesis Methods 15(4)",
        doi: "10.1002/jrsm.1715",
        note: "Evidence that LLM screening is usable but error-prone; the reason the prescreen only removes records on unanimous, evidence-cited votes and leaves every other decision to humans.",
      },
    ],
  },
];

const byId = new Map(
  REFERENCE_GROUPS.flatMap((g) => g.refs).map((r) => [r.id, r])
);

/** Look up a reference by id; throws in dev if the id is unknown. */
export function refById(id: string): Reference {
  const r = byId.get(id);
  if (!r) throw new Error(`Unknown reference id: ${id}`);
  return r;
}

/** Full formatted reference line, used by the page and for copying. */
export function formatReference(r: Reference): string {
  const doi = r.doi ? ` doi:${r.doi}` : "";
  return `${r.authors} (${r.year}). ${r.title}. ${r.venue}.${doi}`;
}
