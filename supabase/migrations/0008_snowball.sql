-- SimpleSLR Phase 3a: snowballing
-- Run once in the Supabase SQL Editor, after 0007_fulltext.sql.
-- Safe to re-run.
--
-- Import batches learn where they came from, so PRISMA can report
-- records identified via snowballing separately from database searches
-- (the "identification via other methods" arm).

alter table public.import_batches
  add column if not exists origin text not null default 'database'
  check (origin in ('database', 'snowball_backward', 'snowball_forward'));

alter table public.import_batches
  add column if not exists seed_record_id uuid
  references public.records(id) on delete set null;
