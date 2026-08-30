-- Five prescreen framings: the ensemble reaches five votes in every
-- configuration through five distinct procedures (single model runs
-- all five; with both provider keys the five split across two models).
-- Two new procedural framings join the original three:
--   facts:   judges from the criteria-blind extraction only, ignoring
--            the abstract's surface wording entirely.
--   skeptic: builds the strongest ineligibility case, then requires
--            every element of it to be explicit in the text; any
--            inference gap forces a pass.
alter table public.prescreen_votes
  drop constraint if exists prescreen_votes_framing_check;
alter table public.prescreen_votes
  add constraint prescreen_votes_framing_check
  check (framing in ('checklist', 'advocate', 'reviewer', 'facts', 'skeptic'));
