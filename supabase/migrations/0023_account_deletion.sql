-- SimpleSLR: account deletion (GDPR Art. 17)
-- Run once in the Supabase SQL Editor, after 0022. Safe to re-run.
--
-- Design: deleting an account must not destroy a team's audit trail,
-- and many tables reference profiles(id) without cascade precisely so
-- that decisions stay attributable. So deletion works in two layers:
--   1. delete_own_account() (below, called by the app) deletes every
--      project where the caller is the only member, removes the
--      caller's remaining memberships, anonymizes the profile row
--      into a tombstone ("Deleted user"), and refuses if the caller
--      is the only owner of a project that still has other members.
--   2. The server then deletes the auth.users row via the admin API,
--      which ends all sign in. For the profile tombstone to survive
--      that, the profiles -> auth.users cascade FK must go.

-- ----------------------------------------------------------------
-- 1. Let the anonymized profile row outlive the auth user.
-- ----------------------------------------------------------------
alter table public.profiles drop constraint if exists profiles_id_fkey;

-- ----------------------------------------------------------------
-- 2. The deletion function.
-- ----------------------------------------------------------------
create or replace function public.delete_own_account()
returns uuid[]
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_blockers text;
  v_deleted uuid[];
begin
  if v_uid is null then
    raise exception 'not signed in';
  end if;

  -- Projects where the caller is the only owner but other members
  -- remain: deleting would orphan the team, so hand over ownership
  -- (or delete the project) first.
  select string_agg(p.name, ', ') into v_blockers
  from public.projects p
  join public.project_members me
    on me.project_id = p.id and me.user_id = v_uid and me.role = 'owner'
  where exists (
      select 1 from public.project_members o
      where o.project_id = p.id and o.user_id <> v_uid
    )
    and not exists (
      select 1 from public.project_members o
      where o.project_id = p.id and o.user_id <> v_uid
        and o.role = 'owner'
    );
  if v_blockers is not null then
    raise exception 'You are the only owner of: %. Make a teammate an owner in Settings, or delete those reviews, then try again.',
      v_blockers;
  end if;

  -- Delete every project where the caller is the only member; the
  -- cascades remove records, decisions, votes, links, and invites.
  select coalesce(array_agg(p.id), '{}') into v_deleted
  from public.projects p
  where exists (
      select 1 from public.project_members m
      where m.project_id = p.id and m.user_id = v_uid
    )
    and not exists (
      select 1 from public.project_members m
      where m.project_id = p.id and m.user_id <> v_uid
    );
  delete from public.projects where id = any (v_deleted);

  -- Leave every remaining project.
  delete from public.project_members where user_id = v_uid;

  -- Anonymize the tombstone. Rows that must stay attributable for
  -- the audit trail (screening decisions, resolved conflicts) now
  -- show "Deleted user" with no personal data behind it.
  update public.profiles
     set email = null,
         display_name = 'Deleted user'
   where id = v_uid;

  -- Unclaimed invites addressed to the caller die with the account.
  delete from public.project_invites
   where accepted_at is null
     and lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''));

  return v_deleted;
end $$;
