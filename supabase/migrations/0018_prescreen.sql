-- AI prescreen: divert only unmistakably ineligible records away from
-- human screening, PRISMA 2020's "records marked as ineligible by
-- automation tools". A record is auto excluded ONLY when every vote of
-- a deterministic ensemble (three procedural framings, optionally
-- across two models) independently says exclude; everything else goes
-- to humans. Votes are the audit ledger: framing, model, the model
-- version the API reported, verdict, the exclusion criterion cited
-- (verified against the project's criteria), and hashes of the prompt
-- version and criteria text so edits invalidate visibly.

-- Records gain a third status. Auto excluded records leave screening
-- queues and counts exactly like duplicates do, and can be restored.
alter table public.records drop constraint if exists records_status_check;
alter table public.records
  add constraint records_status_check
  check (status in ('active', 'duplicate', 'prescreen_excluded'));

-- Criteria-blind structured reading of a record, stored so judgments
-- have an auditable intermediate ("what the model thought this is").
create table if not exists public.prescreen_extractions (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  record_id uuid not null references public.records(id) on delete cascade,
  model text not null,
  model_version text,
  prompt_version text not null,
  facts jsonb not null,
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  unique (record_id, model, prompt_version)
);

create table if not exists public.prescreen_votes (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  record_id uuid not null references public.records(id) on delete cascade,
  framing text not null check (framing in ('checklist', 'advocate', 'reviewer')),
  model text not null,
  model_version text,
  verdict text not null check (verdict in ('exclude', 'pass', 'cannot_assess')),
  criterion text,
  criterion_verified boolean not null default false,
  note text,
  prompt_version text not null,
  criteria_hash text not null,
  run_id uuid not null,
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  unique (record_id, framing, model, prompt_version, criteria_hash)
);

create index if not exists prescreen_votes_project_idx
  on public.prescreen_votes (project_id, record_id);
create index if not exists prescreen_extractions_project_idx
  on public.prescreen_extractions (project_id, record_id);

alter table public.prescreen_extractions enable row level security;
alter table public.prescreen_votes enable row level security;

drop policy if exists prescreen_extractions_select on public.prescreen_extractions;
create policy prescreen_extractions_select on public.prescreen_extractions
  for select to authenticated using (public.is_member(project_id));
drop policy if exists prescreen_extractions_insert on public.prescreen_extractions;
create policy prescreen_extractions_insert on public.prescreen_extractions
  for insert to authenticated
  with check (public.is_member(project_id) and created_by = auth.uid());
drop policy if exists prescreen_extractions_delete on public.prescreen_extractions;
create policy prescreen_extractions_delete on public.prescreen_extractions
  for delete to authenticated using (public.is_member(project_id));

drop policy if exists prescreen_votes_select on public.prescreen_votes;
create policy prescreen_votes_select on public.prescreen_votes
  for select to authenticated using (public.is_member(project_id));
drop policy if exists prescreen_votes_insert on public.prescreen_votes;
create policy prescreen_votes_insert on public.prescreen_votes
  for insert to authenticated
  with check (public.is_member(project_id) and created_by = auth.uid());
drop policy if exists prescreen_votes_delete on public.prescreen_votes;
create policy prescreen_votes_delete on public.prescreen_votes
  for delete to authenticated using (public.is_member(project_id));
