-- SimpleSLR Phase 1.5: Discovery (PRISMA identification)
-- Run once in the Supabase SQL Editor, after 0001_phase1.sql.
-- Safe to re-run.

-- ---------------------------------------------------------------
-- Projects: research objective + structured search configuration
-- ---------------------------------------------------------------

alter table public.projects
  add column if not exists research_objective text;

alter table public.projects
  add column if not exists search_config jsonb not null default '{}'::jsonb;

-- ---------------------------------------------------------------
-- Databases searched in this review (Scopus, WoS, IEEE, custom...)
-- ---------------------------------------------------------------

create table if not exists public.project_databases (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  name text not null,
  kind text not null default 'custom'
    check (kind in ('scopus', 'wos', 'ieee', 'pubmed', 'custom')),
  enabled boolean not null default true,
  raw_hit_count integer,
  searched_on date,
  notes text,
  position integer not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists project_databases_project_idx
  on public.project_databases (project_id);

alter table public.project_databases enable row level security;

drop policy if exists databases_select on public.project_databases;
create policy databases_select on public.project_databases for select to authenticated
  using (public.is_member(project_id));

drop policy if exists databases_insert on public.project_databases;
create policy databases_insert on public.project_databases for insert to authenticated
  with check (public.is_member(project_id));

drop policy if exists databases_update on public.project_databases;
create policy databases_update on public.project_databases for update to authenticated
  using (public.is_member(project_id)) with check (public.is_member(project_id));

drop policy if exists databases_delete on public.project_databases;
create policy databases_delete on public.project_databases for delete to authenticated
  using (public.is_member(project_id));

-- ---------------------------------------------------------------
-- Import batches: link each import to the database it came from
-- ---------------------------------------------------------------

alter table public.import_batches
  add column if not exists database_id uuid references public.project_databases(id) on delete set null;

create index if not exists import_batches_project_idx
  on public.import_batches (project_id);

create index if not exists records_batch_idx
  on public.records (batch_id);

-- Batches were not deletable in 0001; members may delete them now.
drop policy if exists batches_delete on public.import_batches;
create policy batches_delete on public.import_batches for delete to authenticated
  using (public.is_member(project_id));

-- ---------------------------------------------------------------
-- Records: allow deleting a record other records point at as their
-- duplicate original (the pointer becomes null instead of blocking).
-- ---------------------------------------------------------------

alter table public.records drop constraint if exists records_duplicate_of_fkey;
alter table public.records
  add constraint records_duplicate_of_fkey
  foreign key (duplicate_of) references public.records(id) on delete set null;
