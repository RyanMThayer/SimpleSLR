"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";

type Theme = "system" | "light" | "dark";

const OPTIONS: { value: Theme; label: string; hint: string }[] = [
  { value: "system", label: "System", hint: "Follow the OS setting" },
  { value: "light", label: "Light", hint: "Always light" },
  { value: "dark", label: "Dark", hint: "Always dark" },
];

function applyTheme(t: Theme) {
  const dark =
    t === "dark" ||
    (t === "system" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
}

/**
 * Profile dropdown in the header: theme choice (stored per device in
 * localStorage; the root layout's boot script applies it before first
 * paint) plus sign out.
 */
export default function ThemeMenu({ email }: { email?: string | null }) {
  const [open, setOpen] = useState(false);
  const [theme, setTheme] = useState<Theme>("system");
  // Optional screen name from the user's profile; email is the fallback
  // identity everywhere.
  const [displayName, setDisplayName] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState("");
  const [nameBusy, setNameBusy] = useState(false);
  const [nameMsg, setNameMsg] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const supabase = createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user || cancelled) return;
      const { data } = await supabase
        .from("profiles")
        .select("display_name")
        .eq("id", user.id)
        .single();
      if (cancelled) return;
      const name = (data?.display_name as string | null) ?? null;
       
      setDisplayName(name);
      setNameDraft(name ?? "");
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function saveDisplayName() {
    if (nameBusy) return;
    const name = nameDraft.trim().slice(0, 60) || null;
    setNameBusy(true);
    setNameMsg(null);
    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      setNameBusy(false);
      return;
    }
    const { error } = await supabase
      .from("profiles")
      .update({ display_name: name })
      .eq("id", user.id);
    setNameBusy(false);
    if (error) {
      setNameMsg(error.message);
      return;
    }
    setDisplayName(name);
    setNameMsg(name ? "Saved." : "Cleared; your email shows again.");
    window.setTimeout(() => setNameMsg(null), 2500);
  }

  useEffect(() => {
    // Read-on-mount: the stored choice exists only in the browser.
    let stored: string | null = null;
    try {
      stored = localStorage.getItem("theme");
    } catch {
      // Storage unavailable; stay on system.
    }
    if (stored === "light" || stored === "dark") {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setTheme(stored);
    }
  }, []);

  // In system mode, follow OS theme changes live.
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      try {
        if (!localStorage.getItem("theme")) applyTheme("system");
      } catch {
        applyTheme("system");
      }
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  function choose(t: Theme) {
    setTheme(t);
    try {
      if (t === "system") localStorage.removeItem("theme");
      else localStorage.setItem("theme", t);
    } catch {
      // Not persisted, but still applied for this page view.
    }
    applyTheme(t);
  }

  const shown = displayName || email || "";
  const initial = shown.trim().charAt(0).toUpperCase() || "?";

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex items-center gap-2 rounded-full border border-zinc-300 py-1 pl-1 pr-3 text-sm text-zinc-700 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
      >
        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-teal-700 text-xs font-semibold text-white dark:bg-teal-400 dark:text-teal-950">
          {initial}
        </span>
        {shown && (
          <span className="hidden max-w-48 truncate sm:inline">{shown}</span>
        )}
        <span className="text-zinc-500 dark:text-zinc-400">▾</span>
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} />
          <div className="absolute right-0 z-30 mt-1 w-64 rounded-xl border border-zinc-200 bg-white p-2 shadow-lg dark:border-zinc-700 dark:bg-zinc-900">
            <p className="px-2 pb-1 pt-0.5 text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
              Display name
            </p>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                saveDisplayName();
              }}
              className="mb-1 flex gap-1.5 px-2 pb-1"
            >
              <input
                value={nameDraft}
                onChange={(e) => setNameDraft(e.target.value)}
                placeholder="Optional screen name"
                maxLength={60}
                className="h-8 min-w-0 flex-1 rounded-lg border border-zinc-300 bg-white px-2 text-sm text-zinc-900 outline-none focus:border-teal-600 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50"
              />
              <button
                type="submit"
                disabled={nameBusy || (nameDraft.trim() || null) === displayName}
                className="rounded-md border border-zinc-300 px-3 text-sm text-zinc-700 disabled:opacity-40 dark:border-zinc-700 dark:text-zinc-300"
              >
                Save
              </button>
            </form>
            <p className="px-2 pb-2 text-xs text-zinc-500 dark:text-zinc-400">
              {nameMsg ??
                "Shown to teammates instead of your email. Leave empty to use your email."}
            </p>
            <div className="my-1 border-t border-zinc-100 dark:border-zinc-800" />
            <p className="px-2 pb-1 pt-0.5 text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
              Theme
            </p>
            {OPTIONS.map((o) => (
              <button
                key={o.value}
                onClick={() => choose(o.value)}
                title={o.hint}
                className={`flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-left text-sm transition-colors hover:bg-zinc-100 dark:hover:bg-zinc-800 ${
                  theme === o.value
                    ? "font-medium text-teal-700 dark:text-teal-300"
                    : "text-zinc-700 dark:text-zinc-300"
                }`}
              >
                {o.label}
                {theme === o.value && <span>✓</span>}
              </button>
            ))}
            <div className="my-2 border-t border-zinc-100 dark:border-zinc-800" />
            <form action="/auth/signout" method="post">
              <button
                type="submit"
                className="w-full rounded-lg px-2 py-1.5 text-left text-sm text-zinc-700 transition-colors hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
              >
                Sign out
              </button>
            </form>
          </div>
        </>
      )}
    </div>
  );
}
