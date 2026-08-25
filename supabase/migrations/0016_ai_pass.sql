-- SimpleSLR: AI concept pass (per paper suggestions, human reviewed).
-- Run once in the Supabase SQL Editor, after 0015_excerpt_anchors.sql.
-- Safe to re-run.
--
-- record_fulltext caches the extracted text of each PDF page (the same
-- string the reading room's text layer produces), so the server can
-- verify that every AI suggested quote is a real substring of the
-- paper and anchor it. It also powers future full text search.
--
-- concept_suggestions is the quarantine: AI output lands here and only
-- here. Nothing in the matrix, exports, or excerpts changes until a
-- member accepts a suggestion, which copies it into concept_excerpts
-- and records the link. Rejected rows stay, so re-runs do not
-- resurface the same suggestion, and the accepted/rejected counts
-- support honest methods reporting.

create table if not exists public.record_fulltext (
  record_id uuid not null references public.records(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  page int not null,
  content text not null,
  extracted_at timestamptz not null default now(),
  primary key (record_id, page)
);

create index if not exists record_fulltext_project_idx
  on public.record_fulltext (project_id);

alter table public.record_fulltext enable row level security;

drop policy if exists record_fulltext_select on public.record_fulltext;
create policy record_fulltext_select on public.record_fulltext
  for select to authenticated using (public.is_member(project_id));
drop policy if exists record_fulltext_insert on public.record_fulltext;
create policy record_fulltext_insert on public.record_fulltext
  for insert to authenticated with check (public.is_member(project_id));
drop policy if exists record_fulltext_update on public.record_fulltext;
create policy record_fulltext_update on public.record_fulltext
  for update to authenticated
  using (public.is_member(project_id)) with check (public.is_member(project_id));
drop policy if exists record_fulltext_delete on public.record_fulltext;
create policy record_fulltext_delete on public.record_fulltext
  for delete to authenticated using (public.is_member(project_id));

create table if not exists public.concept_suggestions (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  record_id uuid not null references public.records(id) on delete cascade,
  run_id uuid not null,
  -- Existing concept, or null when the AI proposes a new one.
  concept_id uuid references public.concepts(id) on delete cascade,
  concept_label text not null,
  definition text,
  quote text not null,
  page int,
  pos_start int,
  pos_end int,
  prefix text,
  suffix text,
  note text,
  status text not null default 'pending'
    check (status in ('pending', 'accepted', 'rejected')),
  model text,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  decided_by uuid references public.profiles(id),
  decided_at timestamptz,
  accepted_excerpt_id uuid references public.concept_excerpts(id) on delete set null
);

create index if not exists concept_suggestions_record_idx
  on public.concept_suggestions (record_id, status);
create index if not exists concept_suggestions_project_idx
  on public.concept_suggestions (project_id);

alter table public.concept_suggestions enable row level security;

drop policy if exists concept_suggestions_select on public.concept_suggestions;
create policy concept_suggestions_select on public.concept_suggestions
  for select to authenticated using (public.is_member(project_id));
drop policy if exists concept_suggestions_insert on public.concept_suggestions;
create policy concept_suggestions_insert on public.concept_suggestions
  for insert to authenticated with check (public.is_member(project_id));
drop policy if exists concept_suggestions_update on public.concept_suggestions;
create policy concept_suggestions_update on public.concept_suggestions
  for update to authenticated
  using (public.is_member(project_id)) with check (public.is_member(project_id));
drop policy if exists concept_suggestions_delete on public.concept_suggestions;
create policy concept_suggestions_delete on public.concept_suggestions
  for delete to authenticated using (public.is_member(project_id));
