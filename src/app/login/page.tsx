"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import SiteFooter from "@/components/SiteFooter";
import { createClient, isSupabaseConfigured } from "@/lib/supabase/client";
import { passwordChecks, passwordOk, strengthLabel } from "@/lib/password";

type Mode = "signin" | "signup" | "forgot";

// Google Identity Services: the sign in runs on THIS origin via an ID
// token (signInWithIdToken), so Google's popup references simpleslr.de
// instead of the Supabase project domain the redirect flow would show.
// The client id is public by design; without it the redirect flow
// button below is the fallback.
const GOOGLE_CLIENT_ID = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;

declare global {
  interface Window {
    google?: {
      accounts: {
        id: {
          initialize: (config: {
            client_id: string;
            nonce?: string;
            callback: (response: { credential: string }) => void;
          }) => void;
          renderButton: (
            element: HTMLElement,
            config: Record<string, unknown>
          ) => void;
        };
      };
    };
  }
}

// Raw nonce goes to Supabase, its SHA-256 hex goes to Google; Supabase
// verifies the pair, which stops a captured ID token being replayed.
async function makeNonce() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const raw = btoa(String.fromCharCode(...bytes));
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(raw)
  );
  const hashed = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return { raw, hashed };
}

function GoogleG() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
      <path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
      />
      <path
        fill="#FBBC05"
        d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
      />
    </svg>
  );
}

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
  // Forgot password: neutral confirmation plus a client side cooldown so
  // the button cannot be hammered (Supabase rate limits server side too).
  const [resetSent, setResetSent] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const configured = isSupabaseConfigured();
  // Google Identity Services state: script loaded, container, nonce.
  const [gsiLoaded, setGsiLoaded] = useState(false);
  // Until Google's button has actually rendered, the classic redirect
  // flow button stands in, so a blocked or failed script never leaves
  // a hole where sign in should be.
  const [gsiRendered, setGsiRendered] = useState(false);
  const gsiDiv = useRef<HTMLDivElement | null>(null);
  const nonceRef = useRef<{ raw: string; hashed: string } | null>(null);

  useEffect(() => {
    if (!configured || !GOOGLE_CLIENT_ID) return;
    if (document.getElementById("gsi-client")) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setGsiLoaded(true);
      return;
    }
    const script = document.createElement("script");
    script.src = "https://accounts.google.com/gsi/client";
    script.id = "gsi-client";
    script.async = true;
    script.onload = () => setGsiLoaded(true);
    document.head.appendChild(script);
  }, [configured]);

  useEffect(() => {
    if (!gsiLoaded || !GOOGLE_CLIENT_ID || mode === "forgot") return;
    const el = gsiDiv.current;
    if (!el) return;
    let cancelled = false;
    (async () => {
      if (!nonceRef.current) nonceRef.current = await makeNonce();
      if (cancelled || !window.google) return;
      window.google.accounts.id.initialize({
        client_id: GOOGLE_CLIENT_ID,
        nonce: nonceRef.current.hashed,
        callback: async (response) => {
          setLoading(true);
          setMessage(null);
          const supabase = createClient();
          const { error } = await supabase.auth.signInWithIdToken({
            provider: "google",
            token: response.credential,
            nonce: nonceRef.current?.raw,
          });
          if (error) {
            setMessage(error.message);
            setLoading(false);
            return;
          }
          router.push("/dashboard");
          router.refresh();
        },
      });
      el.innerHTML = "";
      window.google.accounts.id.renderButton(el, {
        type: "standard",
        theme: document.documentElement.classList.contains("dark")
          ? "filled_black"
          : "outline",
        size: "large",
        text: "continue_with",
        shape: "rectangular",
        width: Math.min(400, el.offsetWidth || 336),
      });
      setGsiRendered(true);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gsiLoaded, mode]);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    setMessage(null);
    const supabase = createClient();

    if (mode === "forgot") {
      if (cooldown > 0) {
        setLoading(false);
        return;
      }
      // Security: the response is identical whether or not an account
      // exists for this address, so the form cannot be used to probe
      // which emails are registered. Rate limit errors are shown
      // generically for the same reason.
      const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: `${window.location.origin}/reset-password`,
      });
      if (error && error.status === 429) {
        setMessage("Too many requests. Please wait a minute and try again.");
      } else {
        setResetSent(true);
        setCooldown(60);
        const timer = setInterval(() => {
          setCooldown((c) => {
            if (c <= 1) clearInterval(timer);
            return Math.max(0, c - 1);
          });
        }, 1000);
      }
      setLoading(false);
      return;
    }

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

  async function signInWithGoogle() {
    if (loading) return;
    setLoading(true);
    setMessage(null);
    const supabase = createClient();
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: `${window.location.origin}/auth/callback` },
    });
    if (error) {
      setLoading(false);
      setMessage(
        /provider/i.test(error.message)
          ? "Google sign in is not enabled yet. Use email and password for now."
          : error.message
      );
    }
    // On success the browser navigates to Google; nothing to do here.
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

  const inputCls =
    "h-11 rounded-lg border border-zinc-300 bg-white px-3 text-base text-zinc-900 outline-none focus:border-teal-600 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50 dark:focus:border-teal-600";

  return (
    <div className="flex flex-1 flex-col items-center justify-center bg-zinc-50 px-6 py-10 font-sans dark:bg-zinc-950">
      <main className="flex w-full max-w-sm flex-col items-center gap-5">
        <Link
          href="/"
          className="font-serif text-xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50"
        >
          SimpleSLR
        </Link>

        {!configured ? (
          <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200">
            Backend not configured yet. Add the Supabase environment variables
            described in SETUP.md, then redeploy.
          </div>
        ) : (
          <>
            <div className="flex w-full flex-col gap-4 rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
              <h1 className="text-center font-serif text-xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
                {mode === "signin"
                  ? "Sign in"
                  : mode === "signup"
                    ? "Create your account"
                    : "Reset your password"}
              </h1>

              {mode !== "forgot" && (
                <>
                  {GOOGLE_CLIENT_ID && (
                    <div
                      ref={gsiDiv}
                      className={
                        gsiRendered
                          ? "flex min-h-11 w-full justify-center"
                          : "hidden"
                      }
                    />
                  )}
                  {!gsiRendered && (
                    <button
                      type="button"
                      onClick={signInWithGoogle}
                      disabled={loading}
                      className="flex h-11 w-full items-center justify-center gap-2.5 rounded-md border border-zinc-300 bg-white text-base font-medium text-zinc-800 transition-colors hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100 dark:hover:bg-zinc-800"
                    >
                      <GoogleG />
                      Continue with Google
                    </button>
                  )}
                  <div className="flex w-full items-center gap-3 text-xs uppercase tracking-wide text-zinc-400 dark:text-zinc-500">
                    <span className="h-px flex-1 bg-zinc-200 dark:bg-zinc-800" />
                    or
                    <span className="h-px flex-1 bg-zinc-200 dark:bg-zinc-800" />
                  </div>
                </>
              )}

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
                    className={inputCls}
                  />
                </label>
                {mode === "forgot" ? (
                  <p className="text-sm text-zinc-600 dark:text-zinc-400">
                    Enter your account email and we will send a link to set a
                    new password.
                  </p>
                ) : (
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
                      className={inputCls}
                    />
                  </label>
                )}
                {mode === "signup" && (
                  <div className="rounded-lg bg-zinc-100 px-3 py-2 text-sm dark:bg-zinc-950">
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
                    (mode === "signup" && !passwordOk(password, email)) ||
                    (mode === "forgot" && cooldown > 0)
                  }
                  className="mt-1 flex h-11 items-center justify-center rounded-md bg-teal-700 px-6 text-base font-medium text-zinc-50 transition-colors hover:bg-teal-800 disabled:opacity-50 dark:bg-teal-400 dark:text-teal-950 dark:hover:bg-teal-300"
                >
                  {loading
                    ? "Please wait..."
                    : mode === "signin"
                      ? "Sign in"
                      : mode === "signup"
                        ? "Create account"
                        : cooldown > 0
                          ? `Send again in ${cooldown}s`
                          : "Send reset link"}
                </button>
                {mode === "signup" && (
                  <p className="text-center text-xs text-zinc-400 dark:text-zinc-500">
                    By creating an account you agree to the{" "}
                    <Link href="/terms" className="underline underline-offset-2">
                      terms
                    </Link>{" "}
                    and the{" "}
                    <Link
                      href="/privacy"
                      className="underline underline-offset-2"
                    >
                      privacy policy
                    </Link>
                    .
                  </p>
                )}
              </form>

              {message && (
                <p className="text-center text-sm text-zinc-700 dark:text-zinc-300">
                  {message}
                </p>
              )}
            </div>

            {mode === "forgot" && resetSent && (
              <div className="w-full rounded-xl border border-teal-300 bg-teal-50 px-4 py-3 text-left text-sm text-teal-900 dark:border-teal-800 dark:bg-teal-950 dark:text-teal-100">
                If an account exists for <strong>{email}</strong>, a password
                reset link is on its way. It is valid for a short time and
                can be used once; check the spam folder if it does not
                arrive within a minute.
              </div>
            )}
            {awaiting && (
              <div className="w-full rounded-xl border border-teal-300 bg-teal-50 px-4 py-3 text-left text-sm text-teal-900 dark:border-teal-800 dark:bg-teal-950 dark:text-teal-100">
                <p className="mb-1 font-semibold">
                  Almost there: confirm your email.
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
                  className="rounded-md border border-teal-400 px-3 py-1 text-sm transition-colors hover:bg-teal-100 disabled:opacity-50 dark:border-teal-700 dark:hover:bg-teal-900"
                >
                  {resendBusy ? "Sending..." : "Resend confirmation email"}
                </button>
                {resendMsg && <p className="mt-1.5 text-xs">{resendMsg}</p>}
              </div>
            )}

            <div className="flex flex-col items-center gap-2">
              {mode === "signin" && (
                <button
                  type="button"
                  onClick={() => {
                    setMode("forgot");
                    setMessage(null);
                  }}
                  className="text-sm text-zinc-500 underline underline-offset-4 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200"
                >
                  Forgot your password?
                </button>
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
                  : mode === "signup"
                    ? "Already have an account? Sign in"
                    : "Back to sign in"}
              </button>
              <a
                href="mailto:support@simpleslr.de"
                className="text-xs text-zinc-400 underline underline-offset-4 hover:text-zinc-600 dark:text-zinc-500 dark:hover:text-zinc-300"
              >
                Trouble signing in? support@simpleslr.de
              </a>
            </div>
          </>
        )}
      </main>
      <SiteFooter />
    </div>
  );
}
