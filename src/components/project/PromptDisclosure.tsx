"use client";

import { useState } from "react";

/**
 * Verbatim prompt disclosure for the Report page: the exact
 * instruction texts the AI features send, with this project's own
 * criteria as configured, so a reader of the manuscript can reproduce
 * the procedure. Collapsed by default; the prompts are the evidence
 * behind the methodology description above them.
 */
export default function PromptDisclosure({
  title,
  intro,
  prompts,
}: {
  title: string;
  intro: string;
  prompts: { label: string; text: string }[];
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-2">
      <button
        onClick={() => setOpen(!open)}
        className="font-sans text-xs text-zinc-500 underline underline-offset-4 hover:text-zinc-700 print:hidden dark:text-zinc-400 dark:hover:text-zinc-200"
      >
        {open ? `Hide ${title}` : `Show ${title}`}
      </button>
      {open && (
        <div className="mt-2 flex flex-col gap-3">
          <p className="font-sans text-xs text-zinc-500 dark:text-zinc-400">
            {intro}
          </p>
          {prompts.map((p) => (
            <div key={p.label}>
              <p className="mb-1 font-sans text-[11px] font-semibold uppercase tracking-widest text-zinc-500 dark:text-zinc-400">
                {p.label}
              </p>
              <pre className="overflow-x-auto rounded-md border border-zinc-200 bg-zinc-50 p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-zinc-700 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-300">
                {p.text}
              </pre>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
