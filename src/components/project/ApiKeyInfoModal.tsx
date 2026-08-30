"use client";

import { useEffect, useState } from "react";
import { keyStoreFor } from "@/lib/aiModels";

/**
 * The "Your API key" explainer: how keys are handled, how to get one
 * from each provider, safety practice, predicted costs, and per
 * provider removal. Shared by Project settings (where keys are
 * managed) and the reading room's AI card.
 */
export default function ApiKeyInfoModal({
  open,
  onClose,
  onKeysChanged,
}: {
  open: boolean;
  onClose: () => void;
  onKeysChanged?: () => void;
}) {
  const [storedKeys, setStoredKeys] = useState({
    anthropic: false,
    openai: false,
  });

  useEffect(() => {
    if (!open) return;
    try {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setStoredKeys({
        anthropic: Boolean(localStorage.getItem(keyStoreFor("anthropic"))),
        openai: Boolean(localStorage.getItem(keyStoreFor("openai"))),
      });
    } catch {
      setStoredKeys({ anthropic: false, openai: false });
    }
  }, [open]);

  function remove(provider: "anthropic" | "openai") {
    try {
      localStorage.removeItem(keyStoreFor(provider));
    } catch {
      // Nothing stored anyway.
    }
    setStoredKeys((s) => ({ ...s, [provider]: false }));
    onKeysChanged?.();
  }

  return (
    <>
    {open && (
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-950/50 p-4"
        onClick={onClose}
      >
        <div
          role="dialog"
          aria-label="About your API key"
          onClick={(e) => e.stopPropagation()}
          className="flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-zinc-200 bg-white text-left shadow-xl dark:border-zinc-800 dark:bg-zinc-900"
        >
          <div className="flex min-h-0 flex-col overflow-y-auto p-6">
          <div className="mb-3 flex items-start justify-between gap-3">
            <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">
              Your API key
            </h2>
            <button
              onClick={onClose}
              aria-label="Close"
              className="rounded-full px-2 py-0.5 text-sm text-zinc-500 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
            >
              ✕
            </button>
          </div>

          <div className="flex flex-col gap-4 text-sm text-zinc-700 dark:text-zinc-300">
            <section>
              <h3 className="mb-1 font-semibold text-zinc-900 dark:text-zinc-50">
                How SimpleSLR uses it
              </h3>
              <p className="text-zinc-600 dark:text-zinc-400">
                Your key is saved only in this browser, never in your
                SimpleSLR account or our database. When you run an AI
                pass, the key travels with that one request; our
                server relays it to Anthropic or OpenAI and forgets
                it, without storing or logging it. Teammates never
                see your key, and each person uses their own. The
                provider bills your account directly, and the AI only
                ever reads one paper at a time; every suggestion
                waits for a human accept or reject.
              </p>
            </section>

            <section>
              <h3 className="mb-1 font-semibold text-zinc-900 dark:text-zinc-50">
                Getting a key
              </h3>
              <p className="mb-1.5 text-zinc-600 dark:text-zinc-400">
                For Claude models, create a key in the{" "}
                <a
                  href="https://console.anthropic.com/settings/keys"
                  target="_blank"
                  rel="noreferrer noopener"
                  className="underline underline-offset-2 hover:text-teal-700 dark:hover:text-teal-300"
                >
                  Anthropic Console
                </a>{" "}
                under API keys (you need an account with billing set
                up or credits added). Keys start with sk-ant-.
              </p>
              <p className="text-zinc-600 dark:text-zinc-400">
                For GPT models, create one in the{" "}
                <a
                  href="https://platform.openai.com/api-keys"
                  target="_blank"
                  rel="noreferrer noopener"
                  className="underline underline-offset-2 hover:text-teal-700 dark:hover:text-teal-300"
                >
                  OpenAI platform
                </a>{" "}
                under API keys, also with billing set up. Keys start
                with sk-. Either way, the key is shown once at
                creation; paste it here right away.
              </p>
            </section>

            <section>
              <h3 className="mb-1 font-semibold text-zinc-900 dark:text-zinc-50">
                Keeping it safe
              </h3>
              <p className="text-zinc-600 dark:text-zinc-400">
                Create a dedicated key just for SimpleSLR and name it
                so you recognize it later. In the same dashboard, set
                a monthly spend limit; both providers support this,
                and it caps the damage if a key ever leaks anywhere.
                You can revoke the key there at any time without
                affecting anything else, then paste a new one here.
                And since the key lives in this browser profile, only
                use it on devices you trust.
              </p>
            </section>

            <section>
              <h3 className="mb-1 font-semibold text-zinc-900 dark:text-zinc-50">
                Predicted costs
              </h3>
              <p className="text-zinc-600 dark:text-zinc-400">
                One pass reads a single paper. Depending on paper
                length, that is usually around a cent with GPT-5.6
                Luna, roughly 5 to 15 cents with Claude Sonnet 5 or
                GPT-5.6 Terra, a few tens of cents with Claude
                Opus 5 or GPT-5.6 Sol, and about double that with
                Claude Fable 5. The model picker shows a live
                estimate for the paper you have open based on its
                measured text. Response length is capped, so every
                pass has a known maximum cost, shown when you hover
                the picker. Exact usage shows up in your provider
                dashboard.
              </p>
            </section>

            <section>
              <h3 className="mb-1 font-semibold text-zinc-900 dark:text-zinc-50">
                Stored in this browser
              </h3>
              <div className="flex flex-wrap gap-2">
                <button
                  onClick={() => remove("anthropic")}
                  disabled={!storedKeys.anthropic}
                  className="rounded-full border border-zinc-300 px-3 py-1 text-xs text-zinc-700 transition-colors hover:border-red-400 hover:text-red-700 disabled:opacity-40 dark:border-zinc-700 dark:text-zinc-300 dark:hover:border-red-700 dark:hover:text-red-300"
                >
                  {storedKeys.anthropic
                    ? "Remove Anthropic key"
                    : "No Anthropic key stored"}
                </button>
                <button
                  onClick={() => remove("openai")}
                  disabled={!storedKeys.openai}
                  className="rounded-full border border-zinc-300 px-3 py-1 text-xs text-zinc-700 transition-colors hover:border-red-400 hover:text-red-700 disabled:opacity-40 dark:border-zinc-700 dark:text-zinc-300 dark:hover:border-red-700 dark:hover:text-red-300"
                >
                  {storedKeys.openai
                    ? "Remove OpenAI key"
                    : "No OpenAI key stored"}
                </button>
              </div>
              <p className="mt-1.5 text-xs text-zinc-500 dark:text-zinc-400">
                Removing a key here only forgets it in this browser;
                revoke it in the provider dashboard to disable it
                everywhere.
              </p>
            </section>
          </div>
          </div>
        </div>
      </div>
    )}


    </>
  );
}
