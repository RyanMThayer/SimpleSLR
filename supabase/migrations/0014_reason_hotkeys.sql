-- SimpleSLR: custom hotkeys for exclusion reasons
-- Run once in the Supabase SQL Editor, after 0013_inclusion_code_moves.sql.
-- Safe to re-run.
--
-- Empty hotkey means automatic: free digits 1-9 are assigned by list
-- order, exactly as before. A stored hotkey (any free digit or letter)
-- overrides that, which is how reasons beyond the ninth get a key.

alter table public.exclusion_reasons
  add column if not exists hotkey text not null default '';
