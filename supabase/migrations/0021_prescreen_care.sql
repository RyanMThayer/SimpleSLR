-- SimpleSLR: prescreen carefulness upgrade (prompt version p3)
-- Run once in the Supabase SQL Editor, after 0020. Safe to re-run.
--
-- Removal now takes three hurdles instead of one: (1) unanimous
-- exclude votes that all ground in the SAME criterion, (2) verbatim
-- evidence quoted from the record's own text on every exclude vote,
-- and (3) a final adversarial plausibility check ("veto") that keeps
-- the record with humans if any reasonable eligible reading exists.
--
-- Schema part: the veto is stored in the vote ledger like any vote
-- (so reruns replay it), and votes now carry the quoted evidence.

alter table public.prescreen_votes
  drop constraint if exists prescreen_votes_framing_check;
alter table public.prescreen_votes
  add constraint prescreen_votes_framing_check
  check (framing in ('checklist', 'advocate', 'reviewer', 'facts', 'skeptic', 'veto'));

alter table public.prescreen_votes
  add column if not exists evidence text;
