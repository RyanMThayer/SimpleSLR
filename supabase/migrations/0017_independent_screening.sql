-- Independent (blind) screening.
--
-- Each stage can require a number of independent opinions per record
-- (1 = classic single screening, today's behavior; 2 = standard dual
-- screening). While a record has fewer opinions than required, nobody
-- sees anyone else's decision on it; at quota it reveals, agreement
-- becomes the team outcome and disagreement becomes a conflict.
--
-- Conflicts are settled with a RESOLUTION: the team's final verdict,
-- recorded by any member after discussion (logged with who and when).
-- A resolution is a verdict, not another opinion, so it lives in its
-- own table; one per record and stage.

alter table public.projects
  add column if not exists required_opinions_ta integer not null default 1
    check (required_opinions_ta between 1 and 3),
  add column if not exists required_opinions_ft integer not null default 1
    check (required_opinions_ft between 1 and 3);

create table if not exists public.screening_resolutions (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  record_id uuid not null references public.records(id) on delete cascade,
  stage text not null check (stage in ('title_abstract', 'full_text')),
  decision text not null check (decision in ('include', 'exclude')),
  reason_id uuid references public.exclusion_reasons(id) on delete set null,
  inclusion_code_id uuid references public.inclusion_codes(id) on delete set null,
  resolved_by uuid not null references public.profiles(id),
  resolved_at timestamptz not null default now(),
  unique (record_id, stage)
);

create index if not exists resolutions_project_idx
  on public.screening_resolutions (project_id, stage);

alter table public.screening_resolutions enable row level security;

drop policy if exists resolutions_select on public.screening_resolutions;
create policy resolutions_select on public.screening_resolutions
  for select to authenticated
  using (public.is_member(project_id));

drop policy if exists resolutions_insert on public.screening_resolutions;
create policy resolutions_insert on public.screening_resolutions
  for insert to authenticated
  with check (public.is_member(project_id) and resolved_by = auth.uid());

drop policy if exists resolutions_update on public.screening_resolutions;
create policy resolutions_update on public.screening_resolutions
  for update to authenticated
  using (public.is_member(project_id))
  with check (public.is_member(project_id) and resolved_by = auth.uid());

drop policy if exists resolutions_delete on public.screening_resolutions;
create policy resolutions_delete on public.screening_resolutions
  for delete to authenticated
  using (public.is_member(project_id));
