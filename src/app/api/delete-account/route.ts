import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Account deletion (GDPR Art. 17). The SQL function does the data
 * work (delete solo reviews, leave team reviews, anonymize the
 * profile into a tombstone, refuse while the caller is a team's only
 * owner); this route then removes the uploaded PDFs of the deleted
 * reviews from storage and deletes the auth user so sign in ends.
 */
export async function POST(req: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = (await req.json().catch(() => null)) as {
    confirm?: string;
  } | null;
  if (body?.confirm !== "DELETE") {
    return NextResponse.json({ error: "Type DELETE to confirm." });
  }

  // Without the service role key the auth user cannot be removed, so
  // refuse up front rather than half deleting.
  const admin = createAdminClient();
  if (!admin) {
    return NextResponse.json({
      error:
        "Account deletion is not configured on this deployment (SUPABASE_SERVICE_ROLE_KEY is missing). Write to support@simpleslr.de and we will delete your account manually.",
    });
  }

  const { data: deleted, error } = await supabase.rpc("delete_own_account");
  if (error) {
    return NextResponse.json({
      error:
        error.message.includes("Could not find the function") ||
        error.message.includes("does not exist")
          ? "Account deletion needs migration 0023_account_deletion.sql; run it in the Supabase SQL Editor first."
          : error.message,
    });
  }

  // Remove the uploaded PDFs of fully deleted reviews. Best effort:
  // an orphaned file in a deleted project's folder is unreachable
  // (the RLS policies key on project membership), so a failure here
  // must not block the deletion itself.
  for (const projectId of (deleted ?? []) as string[]) {
    try {
      const { data: objects } = await admin.storage
        .from("fulltexts")
        .list(projectId, { limit: 1000 });
      if (objects && objects.length > 0) {
        await admin.storage
          .from("fulltexts")
          .remove(objects.map((o) => `${projectId}/${o.name}`));
      }
    } catch {
      // Best effort only.
    }
  }

  const { error: authErr } = await admin.auth.admin.deleteUser(user.id);
  if (authErr) {
    return NextResponse.json({
      error: `Your data was removed, but the sign in account could not be deleted (${authErr.message}). Write to support@simpleslr.de and we will finish it.`,
    });
  }

  await supabase.auth.signOut();
  return NextResponse.json({ ok: true });
}
