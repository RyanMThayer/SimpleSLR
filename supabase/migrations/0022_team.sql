-- SimpleSLR: team management and owner enforcement
-- Run once in the Supabase SQL Editor, after 0021. Safe to re-run.
--
-- Roles existed since 0001 (creator = owner, joiners = member); this
-- migration starts ENFORCING them. Owners manage settings, criteria,
-- the team, and deletion; members screen, read, code, and snowball.
-- It also adds email invites: owners record an invite, the app sends
-- the email, and the invitee is joined automatically on sign-in.

-- ----------------------------------------------------------------
-- Owner helper, mirroring is_member.
-- ----------------------------------------------------------------
create or replace function public.is_owner(p_project uuid)
returns boolean
language sql stable security definer set search_path = public as
$$ select exists (
     select 1 from public.project_members
     where project_id = p_project
       and user_id = auth.uid()
       and role = 'owner'
   ) $$;

-- ----------------------------------------------------------------
-- Owner-only: project settings (name, RO/RQ, criteria text, quotas,
-- keywords) and the criteria lists.
-- ----------------------------------------------------------------
drop policy if exists projects_update on public.projects;
create policy projects_update on public.projects for update to authenticated
  using (public.is_owner(id)) with check (public.is_owner(id));

drop policy if exists reasons_insert on public.exclusion_reasons;
create policy reasons_insert on public.exclusion_reasons for insert to authenticated
  with check (public.is_owner(project_id));
drop policy if exists reasons_update on public.exclusion_reasons;
create policy reasons_update on public.exclusion_reasons for update to authenticated
  using (public.is_owner(project_id)) with check (public.is_owner(project_id));
drop policy if exists reasons_delete on public.exclusion_reasons;
create policy reasons_delete on public.exclusion_reasons for delete to authenticated
  using (public.is_owner(project_id));

drop policy if exists inclusion_codes_insert on public.inclusion_codes;
create policy inclusion_codes_insert on public.inclusion_codes for insert to authenticated
  with check (public.is_owner(project_id));
drop policy if exists inclusion_codes_update on public.inclusion_codes;
create policy inclusion_codes_update on public.inclusion_codes for update to authenticated
  using (public.is_owner(project_id)) with check (public.is_owner(project_id));
drop policy if exists inclusion_codes_delete on public.inclusion_codes;
create policy inclusion_codes_delete on public.inclusion_codes for delete to authenticated
  using (public.is_owner(project_id));

-- The security definer criteria functions get the same owner check.
create or replace function public.delete_reason_and_reset(p_reason uuid)
returns integer
language plpgsql security definer set search_path = public as $$
declare
  v_project uuid;
  v_count integer;
begin
  select project_id into v_project
  from public.exclusion_reasons where id = p_reason;
  if v_project is null then
    raise exception 'reason not found';
  end if;
  if not public.is_owner(v_project) then
    raise exception 'only a project owner can manage the criteria';
  end if;

  delete from public.screening_decisions where reason_id = p_reason;
  get diagnostics v_count = row_count;
  delete from public.exclusion_reasons where id = p_reason;
  return v_count;
end $$;

create or replace function public.update_reason(
  p_reason uuid,
  p_label text,
  p_reset boolean
)
returns integer
language plpgsql security definer set search_path = public as $$
declare
  v_project uuid;
  v_count integer := 0;
begin
  select project_id into v_project
  from public.exclusion_reasons where id = p_reason;
  if v_project is null then
    raise exception 'reason not found';
  end if;
  if not public.is_owner(v_project) then
    raise exception 'only a project owner can manage the criteria';
  end if;
  if coalesce(trim(p_label), '') = '' then
    raise exception 'label required';
  end if;

  update public.exclusion_reasons set label = trim(p_label)
  where id = p_reason;

  if p_reset then
    delete from public.screening_decisions where reason_id = p_reason;
    get diagnostics v_count = row_count;
  end if;
  return v_count;
end $$;

create or replace function public.resolve_inclusion_code(
  p_code uuid,
  p_action text,
  p_target uuid default null,
  p_delete boolean default true
)
returns integer
language plpgsql security definer set search_path = public as $$
declare
  v_project uuid;
  v_target_project uuid;
  v_count integer := 0;
begin
  select project_id into v_project
  from public.inclusion_codes where id = p_code;
  if v_project is null then
    raise exception 'inclusion code not found';
  end if;
  if not public.is_owner(v_project) then
    raise exception 'only a project owner can manage the criteria';
  end if;

  if p_action = 'keep' then
    update public.screening_decisions
       set inclusion_code_id = null
     where inclusion_code_id = p_code;
    get diagnostics v_count = row_count;
  elsif p_action = 'migrate' then
    select project_id into v_target_project
    from public.inclusion_codes where id = p_target;
    if v_target_project is null or v_target_project <> v_project
       or p_target = p_code then
      raise exception 'invalid target code';
    end if;
    update public.screening_decisions
       set inclusion_code_id = p_target
     where inclusion_code_id = p_code;
    get diagnostics v_count = row_count;
  elsif p_action = 'reset' then
    delete from public.screening_decisions
     where inclusion_code_id = p_code;
    get diagnostics v_count = row_count;
  else
    raise exception 'unknown action';
  end if;

  if p_delete then
    delete from public.inclusion_codes where id = p_code;
  end if;
  return v_count;
end $$;

-- ----------------------------------------------------------------
-- Member management, with last-owner protection. All changes go
-- through these functions; direct row updates stay closed.
-- ----------------------------------------------------------------
create or replace function public.set_member_role(
  p_project uuid,
  p_user uuid,
  p_role text
)
returns void
language plpgsql security definer set search_path = public as $$
declare v_owners integer;
begin
  if not public.is_owner(p_project) then
    raise exception 'only a project owner can change roles';
  end if;
  if p_role not in ('owner', 'member') then
    raise exception 'unknown role';
  end if;
  if p_role = 'member' then
    select count(*) into v_owners from public.project_members
    where project_id = p_project and role = 'owner' and user_id <> p_user;
    if v_owners = 0 then
      raise exception 'a project needs at least one owner; promote someone first';
    end if;
  end if;
  update public.project_members set role = p_role
  where project_id = p_project and user_id = p_user;
end $$;

create or replace function public.remove_project_member(
  p_project uuid,
  p_user uuid
)
returns void
language plpgsql security definer set search_path = public as $$
declare v_role text;
begin
  if not public.is_owner(p_project) then
    raise exception 'only a project owner can remove members';
  end if;
  if p_user = auth.uid() then
    raise exception 'use leave_project to leave';
  end if;
  select role into v_role from public.project_members
  where project_id = p_project and user_id = p_user;
  if v_role = 'owner' then
    raise exception 'demote the owner to member before removing them';
  end if;
  delete from public.project_members
  where project_id = p_project and user_id = p_user;
end $$;

create or replace function public.leave_project(p_project uuid)
returns void
language plpgsql security definer set search_path = public as $$
declare v_others integer;
begin
  if public.is_owner(p_project) then
    select count(*) into v_others from public.project_members
    where project_id = p_project and role = 'owner' and user_id <> auth.uid();
    if v_others = 0 then
      raise exception 'you are the only owner; promote someone first or delete the project';
    end if;
  end if;
  delete from public.project_members
  where project_id = p_project and user_id = auth.uid();
end $$;

-- ----------------------------------------------------------------
-- Email invites. The row is the source of truth; the invite email is
-- a courtesy. claim_project_invites() runs at sign-in and joins the
-- user to every project that invited their email address.
-- ----------------------------------------------------------------
create table if not exists public.project_invites (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  email text not null,
  role text not null default 'member' check (role in ('owner', 'member')),
  invited_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  accepted_at timestamptz,
  unique (project_id, email)
);

alter table public.project_invites enable row level security;

drop policy if exists invites_select on public.project_invites;
create policy invites_select on public.project_invites for select to authenticated
  using (public.is_member(project_id));
drop policy if exists invites_insert on public.project_invites;
create policy invites_insert on public.project_invites for insert to authenticated
  with check (public.is_owner(project_id) and invited_by = auth.uid());
drop policy if exists invites_delete on public.project_invites;
create policy invites_delete on public.project_invites for delete to authenticated
  using (public.is_owner(project_id));

create or replace function public.claim_project_invites()
returns integer
language plpgsql security definer set search_path = public as $$
declare
  v_email text;
  v_count integer := 0;
  r record;
begin
  if auth.uid() is null then
    return 0;
  end if;
  v_email := lower(coalesce(auth.jwt() ->> 'email', ''));
  if v_email = '' then
    return 0;
  end if;
  for r in
    select id, project_id, role from public.project_invites
    where lower(email) = v_email and accepted_at is null
  loop
    insert into public.project_members (project_id, user_id, role)
    values (r.project_id, auth.uid(), r.role)
    on conflict (project_id, user_id) do nothing;
    update public.project_invites set accepted_at = now() where id = r.id;
    v_count := v_count + 1;
  end loop;
  return v_count;
end $$;
