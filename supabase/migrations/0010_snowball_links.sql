-- SimpleSLR: per seed snowball provenance
-- Run once in the Supabase SQL Editor, after 0009_concepts.sql.
-- Safe to re-run.
--
-- One row per (found paper, seed paper, direction): records exactly
-- which seed produced each snowball candidate, even when many seeds
-- ran in one round. Used to show provenance in the records view and
-- to offer a cascade when a seed paper is deleted.
--
-- Note: snowball imports made before this migration have batch level
-- origin only; per seed links exist from the next snowball run onward.

create table if not exists public.snowball_links (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  record_id uuid not null references public.records(id) on delete cascade,
  seed_record_id uuid not null references public.records(id) on delete cascade,
  direction text not null check (direction in ('backward', 'forward')),
  created_at timestamptz not null default now(),
  unique (record_id, seed_record_id, direction)
);

create index if not exists snowball_links_project_idx on public.snowball_links (project_id);
create index if not exists snowball_links_record_idx on public.snowball_links (record_id);
create index if not exists snowball_links_seed_idx on public.snowball_links (seed_record_id);

alter table public.snowball_links enable row level security;

drop policy if exists snowball_links_select on public.snowball_links;
create policy snowball_links_select on public.snowball_links for select to authenticated
  using (public.is_member(project_id));
drop policy if exists snowball_links_insert on public.snowball_links;
create policy snowball_links_insert on public.snowball_links for insert to authenticated
  with check (public.is_member(project_id));
drop policy if exists snowball_links_delete on public.snowball_links;
create policy snowball_links_delete on public.snowball_links for delete to authenticated
  using (public.is_member(project_id));
