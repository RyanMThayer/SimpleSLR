-- SimpleSLR: retire the "maybe" decision
-- Run once in the Supabase SQL Editor, after 0003_screening.sql.
--
-- "Maybe" decided nothing: a record is included or excluded, and an
-- undecided record simply stays in the queue (the screening room now
-- supports skipping with the arrow keys instead). Existing maybe
-- decisions are removed so those records return to the queue.

delete from public.screening_decisions where decision = 'maybe';

alter table public.screening_decisions
  drop constraint if exists screening_decisions_decision_check;

alter table public.screening_decisions
  add constraint screening_decisions_decision_check
  check (decision in ('include', 'exclude'));
