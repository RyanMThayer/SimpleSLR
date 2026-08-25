-- SimpleSLR: anchored excerpts for the reading room.
-- Run once in the Supabase SQL Editor, after 0014_reason_hotkeys.sql.
-- Safe to re-run.
--
-- An excerpt created by selecting text in the PDF reader stores where
-- the selection lives so every team member sees the same highlight:
-- pos_start/pos_end are character offsets into the extracted text of
-- that PDF page (the page column from 0009 holds the 1-based page
-- number), and prefix/suffix hold up to 32 characters of surrounding
-- context for fuzzy re-anchoring when offsets stop matching. Pasted
-- excerpts keep all four columns null and simply have no highlight.

alter table public.concept_excerpts
  add column if not exists pos_start int,
  add column if not exists pos_end int,
  add column if not exists prefix text,
  add column if not exists suffix text;
