-- SimpleSLR Phase 3: Webster and Watson concept matrix
-- Run once in the Supabase SQL Editor, after 0008_snowball.sql.
-- Safe to re-run.
--
-- The concept matrix is a shared team artifact: any project member may
-- create, rename, merge, and delete concepts, and tag any paper. Tags
-- record paper-by-concept membership (with optional unit of analysis
-- and note); excerpts store pasted evidence passages for a tag.

create table if not exists public.concepts (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  label text not null,
  description text,
  position int not null default 0,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now()
);

create table if not exists public.concept_tags (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  concept_id uuid not null references public.concepts(id) on delete cascade,
  record_id uuid not null references public.records(id) on delete cascade,
  unit text,
  note text,
  tagged_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  unique (concept_id, record_id)
);

create table if not exists public.concept_excerpts (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  concept_id uuid not null references public.concepts(id) on delete cascade,
  record_id uuid not null references public.records(id) on delete cascade,
  quote text not null,
  page int,
  added_by uuid references public.profiles(id),
  created_at timestamptz not null default now()
);

create index if not exists concepts_project_idx on public.concepts (project_id);
create index if not exists concept_tags_project_idx on public.concept_tags (project_id);
create index if not exists concept_tags_record_idx on public.concept_tags (record_id);
create index if not exists concept_excerpts_project_idx on public.concept_excerpts (project_id);
create index if not exists concept_excerpts_record_idx on public.concept_excerpts (record_id);

alter table public.concepts enable row level security;
alter table public.concept_tags enable row level security;
alter table public.concept_excerpts enable row level security;

drop policy if exists concepts_select on public.concepts;
create policy concepts_select on public.concepts for select to authenticated
  using (public.is_member(project_id));
drop policy if exists concepts_insert on public.concepts;
create policy concepts_insert on public.concepts for insert to authenticated
  with check (public.is_member(project_id));
drop policy if exists concepts_update on public.concepts;
create policy concepts_update on public.concepts for update to authenticated
  using (public.is_member(project_id)) with check (public.is_member(project_id));
drop policy if exists concepts_delete on public.concepts;
create policy concepts_delete on public.concepts for delete to authenticated
  using (public.is_member(project_id));

drop policy if exists concept_tags_select on public.concept_tags;
create policy concept_tags_select on public.concept_tags for select to authenticated
  using (public.is_member(project_id));
drop policy if exists concept_tags_insert on public.concept_tags;
create policy concept_tags_insert on public.concept_tags for insert to authenticated
  with check (public.is_member(project_id));
drop policy if exists concept_tags_update on public.concept_tags;
create policy concept_tags_update on public.concept_tags for update to authenticated
  using (public.is_member(project_id)) with check (public.is_member(project_id));
drop policy if exists concept_tags_delete on public.concept_tags;
create policy concept_tags_delete on public.concept_tags for delete to authenticated
  using (public.is_member(project_id));

drop policy if exists concept_excerpts_select on public.concept_excerpts;
create policy concept_excerpts_select on public.concept_excerpts for select to authenticated
  using (public.is_member(project_id));
drop policy if exists concept_excerpts_insert on public.concept_excerpts;
create policy concept_excerpts_insert on public.concept_excerpts for insert to authenticated
  with check (public.is_member(project_id));
drop policy if exists concept_excerpts_update on public.concept_excerpts;
create policy concept_excerpts_update on public.concept_excerpts for update to authenticated
  using (public.is_member(project_id)) with check (public.is_member(project_id));
drop policy if exists concept_excerpts_delete on public.concept_excerpts;
create policy concept_excerpts_delete on public.concept_excerpts for delete to authenticated
  using (public.is_member(project_id));

-- Merge concept p_src into p_dst atomically: repoint tags (destination
-- wins where a paper carries both), repoint excerpts, delete the source.
create or replace function public.merge_concepts(p_src uuid, p_dst uuid)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_src_project uuid;
  v_dst_project uuid;
begin
  if p_src = p_dst then
    raise exception 'cannot merge a concept into itself';
  end if;
  select project_id into v_src_project from public.concepts where id = p_src;
  select project_id into v_dst_project from public.concepts where id = p_dst;
  if v_src_project is null or v_dst_project is null
     or v_src_project <> v_dst_project then
    raise exception 'concepts not found or in different projects';
  end if;
  if not public.is_member(v_src_project) then
    raise exception 'not a member of this project';
  end if;

  update public.concept_tags t
     set concept_id = p_dst
   where t.concept_id = p_src
     and not exists (
       select 1 from public.concept_tags d
       where d.concept_id = p_dst and d.record_id = t.record_id
     );
  delete from public.concept_tags where concept_id = p_src;

  update public.concept_excerpts
     set concept_id = p_dst
   where concept_id = p_src;

  delete from public.concepts where id = p_src;
end;
$$;
