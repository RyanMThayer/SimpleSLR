"use client";

import { useEffect, useState } from "react";
import { keyStoreFor } from "@/lib/aiModels";
import ApiKeyInfoModal from "@/components/project/ApiKeyInfoModal";

/**
 * The one place API keys are managed. Keys live in this browser's
 * localStorage only: they ride along with each AI request and are
 * relayed to the provider, never stored or logged on the server, and
 * teammates never see them. Both AI features (the prescreen and the
 * reading room concept pass) read from the same two slots.
 */
export default function ApiKeysCard() {
  const [hasAnthropic, setHasAnthropic] = useState(false);
  const [hasOpenai, setHasOpenai] = useState(false);
  const [draft, setDraft] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [infoOpen, setInfoOpen] = useState(false);

  function refresh() {
    try {
      setHasAnthropic(Boolean(localStorage.getItem(keyStoreFor("anthropic"))));
      setHasOpenai(Boolean(localStorage.getItem(keyStoreFor("openai"))));
    } catch {
      // Storage unavailable.
    }
  }

  useEffect(() => {
    try {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setHasAnthropic(Boolean(localStorage.getItem(keyStoreFor("anthropic"))));
      setHasOpenai(Boolean(localStorage.getItem(keyStoreFor("openai"))));
    } catch {
      // Storage unavailable; the card just shows nothing saved.
    }
  }, []);

  function save() {
    const k = draft.trim();
    if (!k) return;
    // Route by the key itself: sk-ant-* is Anthropic, other keys are
    // OpenAI, so pasting the "wrong" one still lands correctly.
    const target = k.startsWith("sk-ant-") ? "anthropic" : "openai";
    try {
      localStorage.setItem(keyStoreFor(target), k);
      setDraft("");
      if (target === "anthropic") setHasAnthropic(true);
      else setHasOpenai(true);
      setMsg(
        `Saved your ${target === "anthropic" ? "Anthropic" : "OpenAI"} key in this browser.`
      );
    } catch {
      setMsg("Could not store the key in this browser.");
    }
  }

  function remove(provider: "anthropic" | "openai") {
    try {
      localStorage.removeItem(keyStoreFor(provider));
    } catch {
      // Nothing stored anyway.
    }
    if (provider === "anthropic") setHasAnthropic(false);
    else setHasOpenai(false);
    setMsg(null);
  }

  const row = (provider: "anthropic" | "openai", stored: boolean) => (
    <div className="flex items-center justify-between gap-3 text-sm">
      <span className="text-zinc-700 dark:text-zinc-300">
        {provider === "anthropic" ? "Anthropic" : "OpenAI"} key:{" "}
        {stored ? (
          <span className="font-medium text-emerald-600 dark:text-emerald-400">
            saved in this browser
          </span>
        ) : (
          <span className="text-zinc-500 dark:text-zinc-400">not saved</span>
        )}
      </span>
      {stored && (
        <button
          onClick={() => remove(provider)}
          className="rounded-md border border-zinc-300 px-3 py-1 text-xs text-zinc-700 transition-colors hover:border-red-400 hover:text-red-700 dark:border-zinc-700 dark:text-zinc-300 dark:hover:border-red-700 dark:hover:text-red-300"
        >
          Remove
        </button>
      )}
    </div>
  );

  return (
    <div className="mb-6 flex flex-col gap-3 rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
      <div>
        <h2 className="mb-1 font-serif text-base font-semibold text-zinc-900 dark:text-zinc-50">
          AI API keys
        </h2>
        <p className="text-sm text-zinc-600 dark:text-zinc-300">
          Used by the AI prescreen and the reading room&apos;s concept
          pass. Your key is saved only in this browser, travels with each
          run, and is relayed straight to Anthropic or OpenAI, never
          stored on the server; teammates bring their own. Create a
          dedicated key for SimpleSLR and set a monthly spend limit in the
          provider dashboard so a leak is capped and revocable.{" "}
          <button
            type="button"
            onClick={() => setInfoOpen(true)}
            className="underline underline-offset-2 hover:text-teal-700 dark:hover:text-teal-300"
          >
            How your key is handled, how to get one, and what runs cost
          </button>
        </p>
      </div>
      <ApiKeyInfoModal
        open={infoOpen}
        onClose={() => setInfoOpen(false)}
        onKeysChanged={refresh}
      />
      {row("anthropic", hasAnthropic)}
      {row("openai", hasOpenai)}
      <div className="flex gap-1.5">
        <input
          type="password"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") save();
          }}
          placeholder="sk-... or sk-ant-..."
          className="h-9 min-w-0 flex-1 rounded-lg border border-zinc-300 bg-white px-3 text-sm text-zinc-900 outline-none focus:border-teal-600 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50"
        />
        <button
          onClick={save}
          disabled={!draft.trim()}
          className="rounded-md border border-zinc-300 px-4 text-sm text-zinc-700 disabled:opacity-40 dark:border-zinc-700 dark:text-zinc-300"
        >
          Save
        </button>
      </div>
      {msg && (
        <p className="text-sm text-emerald-600 dark:text-emerald-400">{msg}</p>
      )}
    </div>
  );
}
