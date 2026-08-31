"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import type { ProjectMember } from "@/lib/types";

/**
 * Team management: the member list with roles, owner controls
 * (promote, demote, remove), leaving, and email invites. Owners
 * manage settings, criteria, the team, and deletion; members screen,
 * read, code, and snowball. Every mutation goes through security
 * definer functions that protect the last owner.
 */
export default function TeamCard({
  projectId,
  userId,
}: {
  projectId: string;
  userId: string;
}) {
  const router = useRouter();
  const [members, setMembers] = useState<ProjectMember[]>([]);
  const [invites, setInvites] = useState<
    { id: string; email: string; accepted_at: string | null }[]
  >([]);
  const [inviteEmail, setInviteEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const myRole =
    members.find((m) => m.user_id === userId)?.role ?? "member";

  const load = useCallback(async () => {
    const supabase = createClient();
    const { data: mem } = await supabase
      .from("project_members")
      .select("project_id, user_id, role, joined_at, profiles(display_name, email)")
      .eq("project_id", projectId)
      .order("joined_at");
    setMembers((mem ?? []) as unknown as ProjectMember[]);
    // Absent before migration 0022; an error just means no invites.
    const { data: inv } = await supabase
      .from("project_invites")
      .select("id, email, accepted_at")
      .eq("project_id", projectId)
      .is("accepted_at", null)
      .order("created_at");
    setInvites(inv ?? []);
  }, [projectId]);

  useEffect(() => {
    // Fetch-on-mount: state updates happen after awaits inside load().
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  async function act(
    fn: () => PromiseLike<{ error: { message: string } | null }>
  ) {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    setError(null);
    const { error: err } = await fn();
    setBusy(false);
    if (err) {
      setError(
        err.message.includes("Could not find the function") ||
          err.message.includes("does not exist")
          ? "Team management needs migration 0022_team.sql; run it in the Supabase SQL Editor first."
          : err.message
      );
      return;
    }
    load();
  }

  async function setRole(user: string, role: "owner" | "member") {
    const supabase = createClient();
    await act(() =>
      supabase.rpc("set_member_role", {
        p_project: projectId,
        p_user: user,
        p_role: role,
      })
    );
  }

  async function removeMember(user: string) {
    const supabase = createClient();
    await act(() =>
      supabase.rpc("remove_project_member", {
        p_project: projectId,
        p_user: user,
      })
    );
  }

  async function leave() {
    const supabase = createClient();
    setBusy(true);
    setError(null);
    const { error: err } = await supabase.rpc("leave_project", {
      p_project: projectId,
    });
    setBusy(false);
    if (err) {
      setError(err.message);
      return;
    }
    router.push("/dashboard");
  }

  async function invite() {
    const email = inviteEmail.trim();
    if (!email || busy) return;
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      const res = await fetch("/api/invite", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId, email }),
      });
      const data = await res.json().catch(() => null);
      if (!data || data.error) {
        setError(data?.error ?? "The invite could not be recorded.");
      } else {
        setInviteEmail("");
        setMessage(
          data.emailSent
            ? `Invite email sent to ${email}.`
            : (data.note ?? `Invite recorded for ${email}.`)
        );
        load();
      }
    } catch {
      setError("The invite could not be recorded.");
    }
    setBusy(false);
  }

  async function revokeInvite(id: string) {
    const supabase = createClient();
    await act(() =>
      supabase.from("project_invites").delete().eq("id", id)
    );
  }

  const nameOf = (m: ProjectMember) =>
    m.profiles?.display_name || m.profiles?.email || m.user_id.slice(0, 8);

  return (
    <div className="mb-6 flex flex-col gap-3 rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
      <div>
        <h2 className="mb-1 text-base font-semibold text-zinc-900 dark:text-zinc-50">
          Team
        </h2>
        <p className="text-sm text-zinc-600 dark:text-zinc-300">
          Owners manage settings, criteria, the team, and deletion;
          members screen, read, code, and snowball. Teammates can also
          join with the invite code on the project page.
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        {members.map((m) => (
          <div
            key={m.user_id}
            className="flex flex-wrap items-center gap-2 text-sm"
          >
            <span className="min-w-0 flex-1 truncate text-zinc-800 dark:text-zinc-200">
              {nameOf(m)}
              {m.user_id === userId ? " (you)" : ""}
            </span>
            <span
              className={`rounded-full px-2 py-0.5 text-xs ${
                m.role === "owner"
                  ? "bg-teal-100 text-teal-800 dark:bg-teal-900 dark:text-teal-200"
                  : "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"
              }`}
            >
              {m.role}
            </span>
            {myRole === "owner" && m.user_id !== userId && (
              <span className="flex gap-2">
                <button
                  onClick={() =>
                    setRole(
                      m.user_id,
                      m.role === "owner" ? "member" : "owner"
                    )
                  }
                  disabled={busy}
                  className="text-xs text-zinc-500 underline underline-offset-2 hover:text-zinc-700 disabled:opacity-50 dark:text-zinc-400 dark:hover:text-zinc-200"
                >
                  {m.role === "owner" ? "make member" : "make owner"}
                </button>
                {m.role === "member" && (
                  <button
                    onClick={() => removeMember(m.user_id)}
                    disabled={busy}
                    className="text-xs text-zinc-500 underline underline-offset-2 hover:text-red-600 disabled:opacity-50 dark:text-zinc-400"
                  >
                    remove
                  </button>
                )}
              </span>
            )}
          </div>
        ))}
      </div>

      {myRole === "owner" && (
        <div className="flex gap-1.5">
          <input
            type="email"
            value={inviteEmail}
            onChange={(e) => setInviteEmail(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") invite();
            }}
            placeholder="colleague@university.edu"
            className="h-9 min-w-0 flex-1 rounded-lg border border-zinc-300 bg-white px-3 text-sm text-zinc-900 outline-none focus:border-teal-600 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50"
          />
          <button
            onClick={invite}
            disabled={busy || !inviteEmail.trim()}
            className="rounded-full border border-zinc-300 px-4 text-sm text-zinc-700 disabled:opacity-40 dark:border-zinc-700 dark:text-zinc-300"
          >
            Invite by email
          </button>
        </div>
      )}

      {invites.length > 0 && (
        <div className="flex flex-col gap-1 text-sm text-zinc-600 dark:text-zinc-400">
          {invites.map((i) => (
            <div key={i.id} className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate">
                {i.email} · invited, not yet joined
              </span>
              {myRole === "owner" && (
                <button
                  onClick={() => revokeInvite(i.id)}
                  disabled={busy}
                  className="text-xs text-zinc-500 underline underline-offset-2 hover:text-red-600 disabled:opacity-50 dark:text-zinc-400"
                >
                  revoke
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="flex items-center gap-3">
        <button
          onClick={leave}
          disabled={busy}
          className="self-start rounded-full border border-zinc-300 px-3 py-1 text-xs text-zinc-700 transition-colors hover:border-red-400 hover:text-red-700 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:border-red-700 dark:hover:text-red-300"
        >
          Leave project
        </button>
        {message && (
          <span className="text-sm text-emerald-600 dark:text-emerald-400">
            {message}
          </span>
        )}
        {error && (
          <span className="text-sm text-red-600 dark:text-red-400">
            {error}
          </span>
        )}
      </div>
    </div>
  );
}
