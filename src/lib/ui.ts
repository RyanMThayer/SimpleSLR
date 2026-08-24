/**
 * Shared UI tokens: the single place that defines SimpleSLR's visual
 * language. Import these instead of re-declaring class strings.
 *
 * Color roles:
 * - Teal is the action color: primary buttons, selected filters and
 *   tabs, focus rings, progress, success notices.
 * - Emerald and red are RESERVED for screening semantics (include and
 *   exclude) so a glance never confuses an action with a decision.
 * - Amber = conflict or warning, sky = PDF, violet = snowball
 *   provenance.
 *
 * Neutral text tiers (light / dark), all WCAG AA or better on their
 * backgrounds:
 * - Primary: text-zinc-900 / dark:text-zinc-50
 * - Body: text-zinc-700 / dark:text-zinc-300
 * - Secondary (helper text, metadata that must be read):
 *   text-zinc-600 / dark:text-zinc-400
 * - Faint (decoration, disabled, separators only):
 *   text-zinc-500 / dark:text-zinc-500
 */

export const card =
  "rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900";

/** Filled teal call to action. */
export const btnPrimary =
  "rounded-full bg-teal-700 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-teal-800 disabled:opacity-50 dark:bg-teal-400 dark:text-teal-950 dark:hover:bg-teal-300";

/** Neutral outlined button, the workhorse. */
export const btnSecondary =
  "rounded-full border border-zinc-300 px-4 py-2 text-sm text-zinc-700 transition-colors hover:bg-zinc-100 disabled:opacity-40 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800";

/** Compact variant of btnSecondary for toolbars and chips. */
export const btnSecondarySm =
  "rounded-full border border-zinc-300 px-3 py-1.5 text-sm text-zinc-700 transition-colors hover:bg-zinc-100 disabled:opacity-40 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800";

/** Selected state for filter chips and tabs (pairs with btnSecondarySm). */
export const chipActive =
  "border-teal-700 bg-teal-700 text-white dark:border-teal-400 dark:bg-teal-400 dark:text-teal-950";

/** Keyboard key, for hotkey legends and shortcuts. */
export const kbd =
  "rounded border border-zinc-300 bg-zinc-100 px-1.5 py-0.5 font-mono text-[11px] font-medium text-zinc-700 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-200";

/** Small uppercase table or section header label. */
export const thLabel =
  "text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400";

/** Decision badges: emerald and red mean include and exclude, only. */
export const badgeInclude =
  "rounded-full bg-emerald-100 px-2 py-0.5 text-xs text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200";
export const badgeExclude =
  "rounded-full bg-red-100 px-2 py-0.5 text-xs text-red-800 dark:bg-red-900 dark:text-red-200";
export const badgeConflict =
  "rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-900 dark:text-amber-200";

/** Success or confirmation notice (teal, so emerald stays semantic). */
export const noticeSuccess =
  "rounded-lg border border-teal-300 bg-teal-50 px-4 py-3 text-sm text-teal-800 dark:border-teal-800 dark:bg-teal-950 dark:text-teal-200";
