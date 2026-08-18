-- SimpleSLR: full text PDF storage
-- Run once in the Supabase SQL Editor, after 0006_ft_stage.sql.
-- Safe to re-run.
--
-- Creates a PRIVATE storage bucket for full text PDFs. Objects are
-- stored under <project_id>/<record_id>.pdf and every operation is
-- restricted to members of that project. Do not make this bucket
-- public.

alter table public.records
  add column if not exists fulltext_path text;

insert into storage.buckets (id, name, public)
values ('fulltexts', 'fulltexts', false)
on conflict (id) do nothing;

drop policy if exists "fulltexts read" on storage.objects;
create policy "fulltexts read" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'fulltexts'
    and public.is_member(((storage.foldername(name))[1])::uuid)
  );

drop policy if exists "fulltexts insert" on storage.objects;
create policy "fulltexts insert" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'fulltexts'
    and public.is_member(((storage.foldername(name))[1])::uuid)
  );

drop policy if exists "fulltexts update" on storage.objects;
create policy "fulltexts update" on storage.objects
  for update to authenticated
  using (
    bucket_id = 'fulltexts'
    and public.is_member(((storage.foldername(name))[1])::uuid)
  )
  with check (
    bucket_id = 'fulltexts'
    and public.is_member(((storage.foldername(name))[1])::uuid)
  );

drop policy if exists "fulltexts delete" on storage.objects;
create policy "fulltexts delete" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'fulltexts'
    and public.is_member(((storage.foldername(name))[1])::uuid)
  );
