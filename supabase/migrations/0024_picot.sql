-- 0024: optional PICOT framing of the research question.
-- Stored as jsonb {population, intervention, comparison, outcome, time},
-- all strings, null when the project does not use PICOT. Written only
-- through the existing owner-gated projects update policy.

alter table public.projects
  add column if not exists picot jsonb;
