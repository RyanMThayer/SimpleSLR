import Link from "next/link";

/**
 * The small legal footer: privacy policy, terms, imprint, and the
 * support address. Shown on the public pages (landing, login, the
 * legal pages themselves) so the required notices are reachable from
 * everywhere a visitor can be.
 */
export default function SiteFooter() {
  const link =
    "hover:text-zinc-600 dark:hover:text-zinc-300 underline-offset-4 hover:underline";
  return (
    <footer className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1 px-6 py-6 text-xs text-zinc-400 dark:text-zinc-500">
      <Link href="/references" className={link}>
        References
      </Link>
      <Link href="/privacy" className={link}>
        Privacy
      </Link>
      <Link href="/terms" className={link}>
        Terms
      </Link>
      <Link href="/imprint" className={link}>
        Imprint
      </Link>
      <a href="mailto:support@simpleslr.de" className={link}>
        support@simpleslr.de
      </a>
    </footer>
  );
}
