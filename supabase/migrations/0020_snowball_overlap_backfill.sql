-- SimpleSLR: recover snowball overlap for existing data
-- Run once in the Supabase SQL Editor, after 0019_prescreen_framings.sql.
-- Safe to re-run (it only fills pointers that are still empty).
--
-- Snowball imports used to insert an already-known paper as a
-- status "duplicate" row WITHOUT a duplicate_of pointer, and the
-- per-seed provenance link attached to that dead row. The citation
-- map drops links on duplicates, so a paper found by several seeds
-- never showed its overlap. The app now points new links at the
-- keeper directly; this backfill gives HISTORIC duplicate rows their
-- keeper pointer so the map can fold their links onto the keeper.
--
-- Matching mirrors the app's import dedup where SQL allows: a DOI
-- match always wins; otherwise a normalized title match corroborated
-- by the same publication year. Title matches without a year on both
-- sides are left alone rather than guessed.

update public.records d
set duplicate_of = (
  select a.id
  from public.records a
  where a.project_id = d.project_id
    and a.status <> 'duplicate'
    and a.id <> d.id
    and (
      (d.norm_doi is not null and a.norm_doi = d.norm_doi)
      or (
        d.norm_title is not null
        and d.norm_title <> ''
        and a.norm_title = d.norm_title
        and d.year is not null
        and a.year = d.year
      )
    )
  order by
    case
      when d.norm_doi is not null and a.norm_doi = d.norm_doi then 0
      else 1
    end,
    a.created_at
  limit 1
)
where d.status = 'duplicate'
  and d.duplicate_of is null
  and exists (
    select 1
    from public.records a
    where a.project_id = d.project_id
      and a.status <> 'duplicate'
      and a.id <> d.id
      and (
        (d.norm_doi is not null and a.norm_doi = d.norm_doi)
        or (
          d.norm_title is not null
          and d.norm_title <> ''
          and a.norm_title = d.norm_title
          and d.year is not null
          and a.year = d.year
        )
      )
  );
