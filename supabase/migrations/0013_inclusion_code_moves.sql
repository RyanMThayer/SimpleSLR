-- SimpleSLR: inclusion code reorganization
-- Run once in the Supabase SQL Editor, after 0012_inclusion_codes.sql.
-- Safe to re-run.
--
-- Deleting or substantially editing an inclusion code can affect
-- include decisions made by every reviewer, and row level security
-- only lets a user touch their own decisions. This security definer
-- function performs the cross reviewer move after verifying project
-- membership. Actions:
--   keep    - includes stay, the code tag is cleared
--   migrate - includes stay, tags move to another code (p_target)
--   reset   - the include decisions are removed entirely, so the
--             records return to the screening queue
-- With p_delete the code row itself is removed afterwards (used by
-- delete; edit-with-reset keeps the code).

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
  if not public.is_member(v_project) then
    raise exception 'not a member of this project';
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

-- Return one record to undecided for EVERY reviewer at a stage. Row
-- level security only lets a user delete their own decisions; this
-- security definer function performs the team wide reset from the
-- records view after verifying membership.
create or replace function public.reset_record_decisions(
  p_record uuid,
  p_stage text
)
returns integer
language plpgsql security definer set search_path = public as $$
declare
  v_project uuid;
  v_count integer;
begin
  select project_id into v_project
  from public.records where id = p_record;
  if v_project is null then
    raise exception 'record not found';
  end if;
  if not public.is_member(v_project) then
    raise exception 'not a member of this project';
  end if;
  if p_stage not in ('title_abstract', 'full_text') then
    raise exception 'unknown stage';
  end if;

  delete from public.screening_decisions
   where record_id = p_record and stage = p_stage;
  get diagnostics v_count = row_count;
  return v_count;
end $$;
