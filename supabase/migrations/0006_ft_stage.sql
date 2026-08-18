-- SimpleSLR: full text stage assignment and retrieval tracking
-- Run once in the Supabase SQL Editor, after 0005_phase2.sql.
-- Safe to re-run.
--
-- Full text screening gets its own assignment (ft_assigned_to), separate
-- from the title/abstract assignment, and PRISMA 2020's retrieval step
-- gets tracked: records whose full text could not be accessed are marked
-- retrieval_status = 'not_retrieved' and reported separately in the flow
-- diagram instead of disappearing into the excluded counts.

alter table public.records
  add column if not exists ft_assigned_to uuid references public.profiles(id);

alter table public.records
  add column if not exists retrieval_status text
  check (retrieval_status in ('not_retrieved'));

create index if not exists records_ft_assigned_idx
  on public.records (project_id, ft_assigned_to);
