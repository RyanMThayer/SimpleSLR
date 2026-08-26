"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient, isSupabaseConfigured } from "@/lib/supabase/client";
import { passwordChecks, passwordOk, strengthLabel } from "@/lib/password";

type Mode = "signin" | "signup";

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  // Post signup: the address awaiting confirmation, driving the
  // check-your-email panel with its resend button.
  const [awaiting, setAwaiting] = useState<string | null>(null);
  const [resendBusy, setResendBusy] = useState(false);
  const [resendMsg, setResendMsg] = useState<string | null>(null);
  const configured = isSupabaseConfigured();

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    setMessage(null);
    const supabase = createClient();

    if (mode === "signin") {
      const { error } = await supabase.auth.signInWithPassword({
        email,
        password,
      });
      if (error) {
        setMessage(error.message);
        setLoading(false);
        return;
      }
      router.push("/dashboard");
      router.refresh();
    } else {
      if (!passwordOk(password, email)) {
        setMessage("Please meet all the password requirements below.");
        setLoading(false);
        return;
      }
      const { data, error } = await supabase.auth.signUp({ email, password });
      if (error) {
        setMessage(error.message);
        setLoading(false);
        return;
      }
      if (data.session) {
        router.push("/dashboard");
        router.refresh();
      } else {
        // Email confirmation is enabled in Supabase settings.
        setAwaiting(email);
        setMode("signin");
        setLoading(false);
      }
    }
  }

  async function resendConfirmation() {
    if (!awaiting || resendBusy) return;
    setResendBusy(true);
    setResendMsg(null);
    const supabase = createClient();
    const { error } = await supabase.auth.resend({
      type: "signup",
      email: awaiting,
    });
    setResendBusy(false);
    setResendMsg(
      error ? error.message : "Sent again. Give it a minute, and check spam."
    );
  }

  return (
    <div className="flex flex-1 flex-col items-center justify-center bg-zinc-50 px-6 font-sans dark:bg-zinc-950">
      <main className="flex w-full max-w-sm flex-col items-center gap-6 text-center">
        <h1 className="text-3xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
          {mode === "signin" ? "Sign in to SimpleSLR" : "Create your account"}
        </h1>
        {!configured ? (
          <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200">
            Backend not configured yet. Add the Supabase environment variables
            described in SETUP.md, then redeploy.
          </div>
        ) : (
          <>
            <form
              onSubmit={handleSubmit}
              className="flex w-full flex-col gap-3 text-left"
            >
              <label className="flex flex-col gap-1 text-sm font-medium text-zinc-700 dark:text-zinc-300">
                Email
                <input
                  type="email"
                  required
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="h-11 rounded-lg border border-zinc-300 bg-white px-3 text-base text-zinc-900 outline-none focus:border-teal-600 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50 dark:focus:border-teal-600"
                />
              </label>
              <label className="flex flex-col gap-1 text-sm font-medium text-zinc-700 dark:text-zinc-300">
                Password
                <input
                  type="password"
                  required
                  minLength={mode === "signup" ? 8 : 6}
                  autoComplete={
                    mode === "signin" ? "current-password" : "new-password"
                  }
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="h-11 rounded-lg border border-zinc-300 bg-white px-3 text-base text-zinc-900 outline-none focus:border-teal-600 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50 dark:focus:border-teal-600"
                />
              </label>
              {mode === "signup" && (
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
                  {password.length > 0 && passwordOk(password, email) && (
                    <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                      Strength: {strengthLabel(password)}
                      {strengthLabel(password) !== "strong" &&
                        " · longer with mixed case or symbols is stronger"}
                    </p>
                  )}
                </div>
              )}
              <button
                type="submit"
                disabled={
                  loading ||
                  (mode === "signup" && !passwordOk(password, email))
                }
                className="mt-2 flex h-11 items-center justify-center rounded-full bg-teal-700 px-6 text-base font-medium text-zinc-50 transition-colors hover:bg-teal-800 disabled:opacity-50 dark:bg-teal-400 dark:text-teal-950 dark:hover:bg-teal-300"
              >
                {loading
                  ? "Please wait..."
                  : mode === "signin"
                    ? "Sign in"
                    : "Create account"}
              </button>
            </form>
            {awaiting && (
              <div className="w-full rounded-xl border border-teal-300 bg-teal-50 px-4 py-3 text-left text-sm text-teal-900 dark:border-teal-800 dark:bg-teal-950 dark:text-teal-100">
                <p className="mb-1 font-semibold">
                  Almost there — confirm your email.
                </p>
                <p className="mb-2">
                  A confirmation link was sent to <strong>{awaiting}</strong>.
                  It comes from Supabase (our sign in provider), so if it is
                  not in your inbox within a minute, check the spam folder.
                  After confirming, sign in here.
                </p>
                <button
                  type="button"
                  onClick={resendConfirmation}
                  disabled={resendBusy}
                  className="rounded-full border border-teal-400 px-3 py-1 text-sm transition-colors hover:bg-teal-100 disabled:opacity-50 dark:border-teal-700 dark:hover:bg-teal-900"
                >
                  {resendBusy ? "Sending..." : "Resend confirmation email"}
                </button>
                {resendMsg && <p className="mt-1.5 text-xs">{resendMsg}</p>}
              </div>
            )}
            {message && (
              <p className="text-sm text-zinc-700 dark:text-zinc-300">
                {message}
              </p>
            )}
            <button
              type="button"
              onClick={() => {
                setMode(mode === "signin" ? "signup" : "signin");
                setMessage(null);
              }}
              className="text-sm text-zinc-500 underline underline-offset-4 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200"
            >
              {mode === "signin"
                ? "No account yet? Create one"
                : "Already have an account? Sign in"}
            </button>
          </>
        )}
      </main>
    </div>
  );
}
