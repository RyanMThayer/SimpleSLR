-- SimpleSLR: screening room reason management
-- Run once in the Supabase SQL Editor, after 0002_discovery.sql.
-- Safe to re-run.
--
-- Deleting or substantially editing an exclusion reason must return the
-- affected records to the screening queue for EVERY reviewer, but row
-- level security only lets a user delete their own decisions. These
-- security definer functions perform the cross reviewer cleanup after
-- verifying project membership.

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
  if not public.is_member(v_project) then
    raise exception 'not a member of this project';
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
  if not public.is_member(v_project) then
    raise exception 'not a member of this project';
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
