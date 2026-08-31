import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Email invite: an owner records an invite row (the source of truth,
 * claimed automatically at the invitee's next sign-in) and this route
 * additionally sends the invite email through Supabase auth when the
 * service role key is configured. If the address already has an
 * account, no email is needed; the invite is claimed on their next
 * sign-in.
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
    projectId?: string;
    email?: string;
  } | null;
  const projectId = body?.projectId;
  const email = body?.email?.trim().toLowerCase();
  if (!projectId || !email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }

  // Only owners invite; RLS enforces this again on the insert.
  const { data: me } = await supabase
    .from("project_members")
    .select("role")
    .eq("project_id", projectId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (me?.role !== "owner") {
    return NextResponse.json({
      error: "Only a project owner can invite members.",
    });
  }

  const { error: insErr } = await supabase.from("project_invites").insert({
    project_id: projectId,
    email,
    role: "member",
    invited_by: user.id,
  });
  if (insErr) {
    return NextResponse.json({
      error: insErr.message.includes("duplicate")
        ? "That address has already been invited to this project."
        : insErr.message.includes("does not exist")
          ? "Invites need migration 0022_team.sql; run it in the Supabase SQL Editor first."
          : insErr.message,
    });
  }

  // Courtesy email via Supabase auth, when the server can send one.
  const admin = createAdminClient();
  if (!admin) {
    return NextResponse.json({
      ok: true,
      emailSent: false,
      note: "Invite recorded; they join automatically at their next sign-in. To also send invite emails, add SUPABASE_SERVICE_ROLE_KEY to the deployment's environment variables.",
    });
  }
  const origin = new URL(req.url).origin;
  const { error: mailErr } = await admin.auth.admin.inviteUserByEmail(email, {
    redirectTo: origin,
  });
  if (mailErr) {
    const already = /already.*(registered|exists)/i.test(mailErr.message);
    return NextResponse.json({
      ok: true,
      emailSent: false,
      note: already
        ? "They already have an account; the project appears the next time they sign in."
        : `Invite recorded, but the email could not be sent (${mailErr.message}); they still join at their next sign-in.`,
    });
  }
  return NextResponse.json({ ok: true, emailSent: true });
}
