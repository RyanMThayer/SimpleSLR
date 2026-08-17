export type Project = {
  id: string;
  name: string;
  research_question: string | null;
  inclusion_criteria: string | null;
  exclusion_criteria: string | null;
  include_keywords: string[];
  exclude_keywords: string[];
  invite_code: string;
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
export type Decision = "include" | "exclude" | "maybe";

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
