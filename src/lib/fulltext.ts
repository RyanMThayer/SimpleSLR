import { createClient } from "@/lib/supabase/client";

const BUCKET = "fulltexts";

function friendly(message: string): string {
  return message.includes("Bucket not found")
    ? "PDF storage is not set up yet: run supabase/migrations/0007_fulltext.sql in the Supabase SQL Editor."
    : message;
}

export function fulltextPathFor(projectId: string, recordId: string): string {
  return `${projectId}/${recordId}.pdf`;
}

/** Upload (or replace) a record's full text PDF. Returns an error string or null. */
export async function uploadFulltext(
  projectId: string,
  recordId: string,
  file: File
): Promise<string | null> {
  if (file.size > 45 * 1024 * 1024) {
    return "That PDF is larger than the 45 MB limit.";
  }
  const supabase = createClient();
  const path = fulltextPathFor(projectId, recordId);
  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(path, file, { upsert: true, contentType: "application/pdf" });
  if (error) return friendly(error.message);
  const { error: upErr } = await supabase
    .from("records")
    .update({ fulltext_path: path })
    .eq("id", recordId);
  return upErr ? upErr.message : null;
}

/** Short lived signed URL for viewing a stored PDF. */
export async function signedFulltextUrl(
  path: string
): Promise<{ url?: string; error?: string }> {
  const supabase = createClient();
  const { data, error } = await supabase.storage
    .from(BUCKET)
    .createSignedUrl(path, 3600);
  if (error || !data) {
    return { error: friendly(error?.message ?? "Could not create a link.") };
  }
  return { url: data.signedUrl };
}

/** Remove one record's PDF and clear its pointer. Returns error or null. */
export async function removeFulltext(
  recordId: string,
  path: string
): Promise<string | null> {
  const supabase = createClient();
  const { error } = await supabase.storage.from(BUCKET).remove([path]);
  if (error && !error.message.toLowerCase().includes("not found")) {
    return friendly(error.message);
  }
  const { error: upErr } = await supabase
    .from("records")
    .update({ fulltext_path: null })
    .eq("id", recordId);
  return upErr ? upErr.message : null;
}

/** Best effort bulk cleanup when records are deleted. */
export async function removeFulltextPaths(paths: string[]): Promise<void> {
  const real = paths.filter(Boolean);
  if (real.length === 0) return;
  const supabase = createClient();
  for (let i = 0; i < real.length; i += 100) {
    await supabase.storage.from(BUCKET).remove(real.slice(i, i + 100));
  }
}
