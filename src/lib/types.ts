export type SearchFields = {
  title: boolean;
  abstract: boolean;
  keywords: boolean;
  /** Search the entire record (all fields); overrides the three above. */
  fullRecord: boolean;
};

export type SearchGroup = {
  /** Terms OR'd together inside this concept group. */
  terms: string[];
  /** When true, this group is excluded (NOT) instead of required. */
  not?: boolean;
};

export type SearchLimits = {
  languages: string;
  yearFrom: number | null;
  yearTo: number | null;
  pubTypes: string;
  notes: string;
};

export type SearchConfig = {
  groups: SearchGroup[];
  fields: SearchFields;
  limits: SearchLimits;
};

export const EMPTY_SEARCH_CONFIG: SearchConfig = {
  groups: [{ terms: [], not: false }],
  fields: { title: true, abstract: true, keywords: true, fullRecord: false },
  limits: { languages: "", yearFrom: null, yearTo: null, pubTypes: "", notes: "" },
};

export type DatabaseKind = "scopus" | "wos" | "ieee" | "pubmed" | "custom";

export type ProjectDatabase = {
  id: string;
  project_id: string;
  name: string;
  kind: DatabaseKind;
  enabled: boolean;
  raw_hit_count: number | null;
  searched_on: string | null;
  notes: string | null;
  position: number;
  created_at: string;
};

export type BatchOrigin = "database" | "snowball_backward" | "snowball_forward";

export type ImportBatch = {
  id: string;
  project_id: string;
  filename: string | null;
  source_label: string | null;
  record_count: number;
  imported_by: string | null;
  database_id: string | null;
  origin: BatchOrigin;
  seed_record_id: string | null;
  created_at: string;
};

export type Project = {
  id: string;
  name: string;
  research_objective: string | null;
  research_question: string | null;
  inclusion_criteria: string | null;
  exclusion_criteria: string | null;
  include_keywords: string[];
  exclude_keywords: string[];
  invite_code: string;
  search_config: Partial<SearchConfig> | null;
  created_by: string;
  created_at: string;
};

export type Profile = {
  id: string;
  email: string | null;
  display_name: string | null;
};

export type ProjectMember = {
  project_id: string;
  user_id: string;
  role: "owner" | "member";
  joined_at: string;
  profiles?: Profile;
};

export type RecordRow = {
  id: string;
  project_id: string;
  batch_id: string | null;
  title: string;
  authors: string | null;
  year: number | null;
  venue: string | null;
  abstract: string | null;
  doi: string | null;
  url: string | null;
  source_label: string | null;
  status: "active" | "duplicate";
  duplicate_of: string | null;
  assigned_to: string | null;
  ft_assigned_to: string | null;
  retrieval_status: "not_retrieved" | null;
  fulltext_path: string | null;
  norm_title: string | null;
  norm_doi: string | null;
  created_at: string;
};

export type ExclusionReason = {
  id: string;
  project_id: string;
  label: string;
  position: number;
};

export type Stage = "title_abstract" | "full_text";
export type Decision = "include" | "exclude";

export type ScreeningDecision = {
  id: string;
  project_id: string;
  record_id: string;
  stage: Stage;
  decision: Decision;
  reason_id: string | null;
  note: string | null;
  decided_by: string;
  decided_at: string;
};

/** A reference parsed from an uploaded file, before insertion. */
export type ParsedRef = {
  title: string;
  authors: string | null;
  year: number | null;
  venue: string | null;
  abstract: string | null;
  doi: string | null;
  url: string | null;
};
