-- SimpleSLR Phase 1 schema
-- Run this once in the Supabase SQL Editor (Dashboard -> SQL Editor -> New query -> paste -> Run).
-- Safe to re-run: uses IF NOT EXISTS / OR REPLACE where possible.

create extension if not exists pgcrypto;
create extension if not exists pg_trgm;

-- ---------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  display_name text,
  created_at timestamptz not null default now()
);

create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  research_question text,
  inclusion_criteria text,
  exclusion_criteria text,
  include_keywords text[] not null default '{}',
  exclude_keywords text[] not null default '{}',
  invite_code text not null unique default encode(gen_random_bytes(6), 'hex'),
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now()
);

create table if not exists public.project_members (
  project_id uuid not null references public.projects(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  role text not null default 'member' check (role in ('owner', 'member')),
  joined_at timestamptz not null default now(),
  primary key (project_id, user_id)
);

create table if not exists public.import_batches (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  filename text,
  source_label text,
  record_count integer not null default 0,
  imported_by uuid references public.profiles(id),
  created_at timestamptz not null default now()
);

create table if not exists public.records (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  batch_id uuid references public.import_batches(id) on delete set null,
  title text not null,
  authors text,
  year integer,
  venue text,
  abstract text,
  doi text,
  url text,
  source_label text,
  status text not null default 'active' check (status in ('active', 'duplicate')),
  duplicate_of uuid references public.records(id),
  assigned_to uuid references public.profiles(id),
  norm_title text,
  norm_doi text,
  created_at timestamptz not null default now()
);

create index if not exists records_project_idx on public.records (project_id);
create index if not exists records_project_doi_idx on public.records (project_id, norm_doi);
create index if not exists records_project_title_idx on public.records (project_id, norm_title);
create index if not exists records_project_assigned_idx on public.records (project_id, assigned_to);

create table if not exists public.exclusion_reasons (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  label text not null,
  position integer not null default 0
);

create table if not exists public.screening_decisions (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  record_id uuid not null references public.records(id) on delete cascade,
  stage text not null default 'title_abstract' check (stage in ('title_abstract', 'full_text')),
  decision text not null check (decision in ('include', 'exclude', 'maybe')),
  reason_id uuid references public.exclusion_reasons(id) on delete set null,
  note text,
  decided_by uuid not null references public.profiles(id),
  decided_at timestamptz not null default now(),
  unique (record_id, stage, decided_by)
);

create index if not exists decisions_project_idx on public.screening_decisions (project_id, stage, decided_by);

-- ---------------------------------------------------------------
-- Profile auto-creation on signup (+ backfill for existing users)
-- ---------------------------------------------------------------

create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, display_name)
  values (new.id, new.email, split_part(coalesce(new.email, 'user'), '@', 1))
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

insert into public.profiles (id, email, display_name)
select id, email, split_part(coalesce(email, 'user'), '@', 1)
from auth.users
on conflict (id) do nothing;

-- ---------------------------------------------------------------
-- Membership helpers (security definer avoids RLS recursion)
-- ---------------------------------------------------------------

create or replace function public.is_member(p_project uuid)
returns boolean
language sql stable security definer set search_path = public as
$$ select exists (
     select 1 from public.project_members
     where project_id = p_project and user_id = auth.uid()
   ) $$;

create or replace function public.shares_project_with(p_user uuid)
returns boolean
language sql stable security definer set search_path = public as
$$ select exists (
     select 1
     from public.project_members a
     join public.project_members b on a.project_id = b.project_id
     where a.user_id = auth.uid() and b.user_id = p_user
   ) $$;

-- ---------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------

alter table public.profiles enable row level security;
alter table public.projects enable row level security;
alter table public.project_members enable row level security;
alter table public.import_batches enable row level security;
alter table public.records enable row level security;
alter table public.exclusion_reasons enable row level security;
alter table public.screening_decisions enable row level security;

drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles for select to authenticated
  using (id = auth.uid() or public.shares_project_with(id));

drop policy if exists profiles_update on public.profiles;
create policy profiles_update on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

drop policy if exists projects_select on public.projects;
create policy projects_select on public.projects for select to authenticated
  using (public.is_member(id));

drop policy if exists projects_update on public.projects;
create policy projects_update on public.projects for update to authenticated
  using (public.is_member(id)) with check (public.is_member(id));

drop policy if exists projects_delete on public.projects;
create policy projects_delete on public.projects for delete to authenticated
  using (exists (
    select 1 from public.project_members
    where project_id = id and user_id = auth.uid() and role = 'owner'
  ));

drop policy if exists members_select on public.project_members;
create policy members_select on public.project_members for select to authenticated
  using (public.is_member(project_id));

drop policy if exists members_delete on public.project_members;
create policy members_delete on public.project_members for delete to authenticated
  using (user_id = auth.uid());

drop policy if exists batches_select on public.import_batches;
create policy batches_select on public.import_batches for select to authenticated
  using (public.is_member(project_id));

drop policy if exists batches_insert on public.import_batches;
create policy batches_insert on public.import_batches for insert to authenticated
  with check (public.is_member(project_id) and imported_by = auth.uid());

drop policy if exists batches_update on public.import_batches;
create policy batches_update on public.import_batches for update to authenticated
  using (public.is_member(project_id)) with check (public.is_member(project_id));

drop policy if exists records_select on public.records;
create policy records_select on public.records for select to authenticated
  using (public.is_member(project_id));

drop policy if exists records_insert on public.records;
create policy records_insert on public.records for insert to authenticated
  with check (public.is_member(project_id));

drop policy if exists records_update on public.records;
create policy records_update on public.records for update to authenticated
  using (public.is_member(project_id)) with check (public.is_member(project_id));

drop policy if exists records_delete on public.records;
create policy records_delete on public.records for delete to authenticated
  using (public.is_member(project_id));

drop policy if exists reasons_select on public.exclusion_reasons;
create policy reasons_select on public.exclusion_reasons for select to authenticated
  using (public.is_member(project_id));

drop policy if exists reasons_insert on public.exclusion_reasons;
create policy reasons_insert on public.exclusion_reasons for insert to authenticated
  with check (public.is_member(project_id));

drop policy if exists reasons_update on public.exclusion_reasons;
create policy reasons_update on public.exclusion_reasons for update to authenticated
  using (public.is_member(project_id)) with check (public.is_member(project_id));

drop policy if exists reasons_delete on public.exclusion_reasons;
create policy reasons_delete on public.exclusion_reasons for delete to authenticated
  using (public.is_member(project_id));

drop policy if exists decisions_select on public.screening_decisions;
create policy decisions_select on public.screening_decisions for select to authenticated
  using (public.is_member(project_id));

drop policy if exists decisions_insert on public.screening_decisions;
create policy decisions_insert on public.screening_decisions for insert to authenticated
  with check (public.is_member(project_id) and decided_by = auth.uid());

drop policy if exists decisions_update on public.screening_decisions;
create policy decisions_update on public.screening_decisions for update to authenticated
  using (decided_by = auth.uid()) with check (decided_by = auth.uid());

drop policy if exists decisions_delete on public.screening_decisions;
create policy decisions_delete on public.screening_decisions for delete to authenticated
  using (decided_by = auth.uid());

-- ---------------------------------------------------------------
-- RPCs: create a project / join by invite code
-- ---------------------------------------------------------------

create or replace function public.create_project(p_name text)
returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  if coalesce(trim(p_name), '') = '' then
    raise exception 'project name required';
  end if;
  insert into public.projects (name, created_by)
  values (trim(p_name), auth.uid())
  returning id into v_id;

  insert into public.project_members (project_id, user_id, role)
  values (v_id, auth.uid(), 'owner');

  insert into public.exclusion_reasons (project_id, label, position) values
    (v_id, 'Not relevant to the research question', 1),
    (v_id, 'Wrong publication type', 2),
    (v_id, 'Not peer reviewed', 3),
    (v_id, 'Wrong language', 4),
    (v_id, 'Full text not available', 5);

  return v_id;
end $$;

create or replace function public.join_project_by_code(p_code text)
returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  select id into v_id from public.projects
  where invite_code = lower(trim(p_code));
  if v_id is null then
    raise exception 'invalid invite code';
  end if;
  insert into public.project_members (project_id, user_id, role)
  values (v_id, auth.uid(), 'member')
  on conflict (project_id, user_id) do nothing;
  return v_id;
end $$;
