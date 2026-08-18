-- SimpleSLR Phase 2: fuzzy duplicate detection
-- Run once in the Supabase SQL Editor, after 0004_no_maybe.sql.
-- Safe to re-run.

create extension if not exists pg_trgm;

create index if not exists records_title_trgm_idx
  on public.records using gin (norm_title gin_trgm_ops);

-- Pairs a member has reviewed and declared "not duplicates", so they
-- stop resurfacing in the queue.
create table if not exists public.dismissed_pairs (
  project_id uuid not null references public.projects(id) on delete cascade,
  a uuid not null references public.records(id) on delete cascade,
  b uuid not null references public.records(id) on delete cascade,
  dismissed_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  primary key (project_id, a, b)
);

alter table public.dismissed_pairs enable row level security;

drop policy if exists dismissed_select on public.dismissed_pairs;
create policy dismissed_select on public.dismissed_pairs for select to authenticated
  using (public.is_member(project_id));

drop policy if exists dismissed_insert on public.dismissed_pairs;
create policy dismissed_insert on public.dismissed_pairs for insert to authenticated
  with check (public.is_member(project_id));

drop policy if exists dismissed_delete on public.dismissed_pairs;
create policy dismissed_delete on public.dismissed_pairs for delete to authenticated
  using (public.is_member(project_id));

-- Near-match candidate pairs among active records, most similar first.
create or replace function public.find_similar_pairs(
  p_project uuid,
  p_threshold real default 0.55
)
returns table (a_id uuid, b_id uuid, sim real)
language sql stable security definer set search_path = public as $$
  select a.id, b.id, similarity(a.norm_title, b.norm_title) as sim
  from public.records a
  join public.records b
    on a.project_id = b.project_id
   and a.id < b.id
   and a.norm_title is not null
   and b.norm_title is not null
   and similarity(a.norm_title, b.norm_title) >= p_threshold
  where a.project_id = p_project
    and a.status = 'active'
    and b.status = 'active'
    and public.is_member(p_project)
    and not exists (
      select 1 from public.dismissed_pairs d
      where d.project_id = p_project
        and ((d.a = a.id and d.b = b.id) or (d.a = b.id and d.b = a.id))
    )
  order by sim desc
  limit 200
$$;
