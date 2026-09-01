import Link from "next/link";

/**
 * The stage header for pages that share one lifecycle stage: a small
 * stage label plus tab links between the pages inside it. Synthesize
 * groups the reading room and the concept matrix; Records groups the
 * records table and duplicate review.
 */
export default function StageTabs({
  stage,
  tabs,
}: {
  stage: string;
  tabs: { href: string; label: string; active: boolean }[];
}) {
  return (
    <div className="mb-4 flex flex-wrap items-center gap-2">
      <span className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
        {stage}
      </span>
      <span className="h-4 w-px bg-zinc-200 dark:bg-zinc-700" />
      {tabs.map((t) =>
        t.active ? (
          <span
            key={t.href}
            className="rounded-md bg-teal-700 px-3 py-1 text-xs font-medium text-zinc-50 dark:bg-teal-400 dark:text-teal-950"
          >
            {t.label}
          </span>
        ) : (
          <Link
            key={t.href}
            href={t.href}
            className="rounded-md border border-zinc-300 px-3 py-1 text-xs font-medium text-zinc-700 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            {t.label}
          </Link>
        )
      )}
    </div>
  );
}
