"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { passwordChecks, passwordOk, strengthLabel } from "@/lib/password";

/**
 * Landing page for the password recovery email. The link carries a one
 * time code that the Supabase browser client exchanges for a session on
 * load; once that session exists, the user may set a new password. On
 * success every OTHER session is revoked, so if the reset was prompted
 * by a suspected account compromise, any hijacked session dies with it.
 * An expired or invalid link gets a neutral message and a path to
 * request a fresh one.
 */

type Stage = "verifying" | "ready" | "done" | "invalid";

export default function ResetPasswordPage() {
  const router = useRouter();
  const [stage, setStage] = useState<Stage>("verifying");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    const supabase = createClient();
    let cancelled = false;
    const sub = supabase.auth.onAuthStateChange((_event, session) => {
      if (cancelled || !session) return;
      setEmail(session.user.email ?? "");
      setStage((s) => (s === "verifying" ? "ready" : s));
    });
    (async () => {
      // The code exchange happens asynchronously on load; poll briefly
      // before declaring the link dead.
      for (let i = 0; i < 10 && !cancelled; i++) {
        const { data } = await supabase.auth.getSession();
        if (data.session) {
          setEmail(data.session.user.email ?? "");
          setStage((s) => (s === "verifying" ? "ready" : s));
          return;
        }
        await new Promise((r) => setTimeout(r, 400));
      }
      if (!cancelled) setStage((s) => (s === "verifying" ? "invalid" : s));
    })();
    return () => {
      cancelled = true;
      sub.data.subscription.unsubscribe();
    };
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !passwordOk(password, email) || password !== confirm) return;
    setBusy(true);
    setMessage(null);
    const supabase = createClient();
    const { error } = await supabase.auth.updateUser({ password });
    if (error) {
      setMessage(error.message);
      setBusy(false);
      return;
    }
    // Security: the password change invalidates everything else. Any
    // other device or stolen session must sign in again with the new
    // password; only this freshly verified session survives.
    await supabase.auth.signOut({ scope: "others" });
    setBusy(false);
    setStage("done");
  }

  const inputCls =
    "h-11 rounded-lg border border-zinc-300 bg-white px-3 text-base text-zinc-900 outline-none focus:border-teal-600 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50 dark:focus:border-teal-600";

  return (
    <div className="flex flex-1 flex-col items-center justify-center bg-zinc-50 px-6 font-sans dark:bg-zinc-950">
      <main className="flex w-full max-w-sm flex-col items-center gap-6 text-center">
        <h1 className="text-3xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
          Reset your password
        </h1>

        {stage === "verifying" && (
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            Checking your reset link...
          </p>
        )}

        {stage === "invalid" && (
          <div className="w-full rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-left text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100">
            <p className="mb-2">
              This reset link is invalid or has expired. Links are single
              use and only valid for a short time.
            </p>
            <Link
              href="/login"
              className="font-medium underline underline-offset-2"
            >
              Request a new one from the sign in page
            </Link>
          </div>
        )}

        {stage === "ready" && (
          <form onSubmit={submit} className="flex w-full flex-col gap-3 text-left">
            <p className="text-sm text-zinc-600 dark:text-zinc-400">
              Setting a new password for <strong>{email}</strong>.
            </p>
            <label className="flex flex-col gap-1 text-sm font-medium text-zinc-700 dark:text-zinc-300">
              New password
              <input
                type="password"
                required
                minLength={8}
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className={inputCls}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm font-medium text-zinc-700 dark:text-zinc-300">
              Repeat new password
              <input
                type="password"
                required
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                className={inputCls}
              />
            </label>
            <div className="rounded-lg bg-zinc-100 px-3 py-2 text-sm dark:bg-zinc-900">
              {passwordChecks(password, email).map((c) => (
                <p
                  key={c.label}
                  className={
                    c.ok
                      ? "text-teal-700 dark:text-teal-300"
                      : "text-zinc-500 dark:text-zinc-400"
                  }
                >
                  {c.ok ? "✓" : "·"} {c.label}
                </p>
              ))}
              <p
                className={
                  confirm.length > 0 && password === confirm
                    ? "text-teal-700 dark:text-teal-300"
                    : "text-zinc-500 dark:text-zinc-400"
                }
              >
                {confirm.length > 0 && password === confirm ? "✓" : "·"} Both
                fields match
              </p>
              {password.length > 0 && passwordOk(password, email) && (
                <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                  Strength: {strengthLabel(password)}
                </p>
              )}
            </div>
            <button
              type="submit"
              disabled={
                busy || !passwordOk(password, email) || password !== confirm
              }
              className="mt-2 flex h-11 items-center justify-center rounded-full bg-teal-700 px-6 text-base font-medium text-zinc-50 transition-colors hover:bg-teal-800 disabled:opacity-50 dark:bg-teal-400 dark:text-teal-950 dark:hover:bg-teal-300"
            >
              {busy ? "Saving..." : "Set new password"}
            </button>
            {message && (
              <p className="text-sm text-red-700 dark:text-red-300">{message}</p>
            )}
          </form>
        )}

        {stage === "done" && (
          <div className="flex w-full flex-col gap-4">
            <div className="rounded-xl border border-teal-300 bg-teal-50 px-4 py-3 text-left text-sm text-teal-900 dark:border-teal-800 dark:bg-teal-950 dark:text-teal-100">
              Password updated. Every other device and session was signed
              out; use the new password from now on.
            </div>
            <button
              onClick={() => {
                router.push("/dashboard");
                router.refresh();
              }}
              className="flex h-11 items-center justify-center rounded-full bg-teal-700 px-6 text-base font-medium text-zinc-50 transition-colors hover:bg-teal-800 dark:bg-teal-400 dark:text-teal-950 dark:hover:bg-teal-300"
            >
              Continue to your reviews
            </button>
          </div>
        )}
      </main>
    </div>
  );
}
