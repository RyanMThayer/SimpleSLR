-- SimpleSLR: inclusion codes
-- Run once in the Supabase SQL Editor, after 0011_snowball_hits.sql.
-- Safe to re-run.
--
-- Optional codes attached to "include" decisions, mirroring the
-- exclusion reasons but with editable single letter hotkeys. Plain
-- include (the I key) stays the default and carries no code. Deleting
-- a code keeps the include decisions and just clears the tag.

create table if not exists public.inclusion_codes (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  label text not null,
  hotkey text not null default '',
  position int not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists inclusion_codes_project_idx
  on public.inclusion_codes (project_id);

alter table public.inclusion_codes enable row level security;

drop policy if exists inclusion_codes_select on public.inclusion_codes;
create policy inclusion_codes_select on public.inclusion_codes for select to authenticated
  using (public.is_member(project_id));
drop policy if exists inclusion_codes_insert on public.inclusion_codes;
create policy inclusion_codes_insert on public.inclusion_codes for insert to authenticated
  with check (public.is_member(project_id));
drop policy if exists inclusion_codes_update on public.inclusion_codes;
create policy inclusion_codes_update on public.inclusion_codes for update to authenticated
  using (public.is_member(project_id)) with check (public.is_member(project_id));
drop policy if exists inclusion_codes_delete on public.inclusion_codes;
create policy inclusion_codes_delete on public.inclusion_codes for delete to authenticated
  using (public.is_member(project_id));

alter table public.screening_decisions
  add column if not exists inclusion_code_id uuid
  references public.inclusion_codes(id) on delete set null;
