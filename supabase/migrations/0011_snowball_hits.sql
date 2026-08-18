-- SimpleSLR: candidate counts for snowball rounds
-- Run once in the Supabase SQL Editor, after 0010_snowball_links.sql.
-- Safe to re-run.
--
-- Number of new candidates a snowball round surfaced (before any
-- selection), stored on the batch it produced. Mirrors the raw hit
-- counts recorded for database searches, so the identification table
-- can show found vs imported for snowballing too.

alter table public.import_batches
  add column if not exists raw_hit_count int;
