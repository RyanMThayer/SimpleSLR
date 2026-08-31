import Link from "next/link";
import SiteFooter from "@/components/SiteFooter";
import { isSupabaseConfigured } from "@/lib/supabase/server";

/**
 * The landing page: a restrained, academic front door. Everything it
 * claims maps to a shipped feature; keep it that way when editing.
 */

const FEATURES = [
  {
    title: "PRISMA 2020, built in",
    body: "Screen with per criterion hotkeys and a complete audit trail, then export the verbatim PRISMA flow diagram, a written summary, and the screening log.",
  },
  {
    title: "Independent screening",
    body: "Blind dual screening with a configurable number of opinions per stage. Disagreements surface for discussion and every resolution is logged.",
  },
  {
    title: "Snowballing with a citation map",
    body: "Backward and forward citation searching from your included papers, with per seed provenance, corpus level deduplication, and an interactive map.",
  },
  {
    title: "Concept centric synthesis",
    body: "A Webster and Watson concept matrix wired to a PDF reading room: verbatim excerpts, anchored quotes, and per concept exports.",
  },
  {
    title: "AI that stays defensible",
    body: "Optional prescreening and concept suggestions, run with your own API key under a prescribed methodology. Unanimous multi pass removal rules, every vote auditable, disclosure text written for your methods section.",
  },
  {
    title: "Private by design",
    body: "No ads, no analytics, no fees. API keys never leave your browser, uploaded PDFs stay private to your team, and your data exports as CSV at any time.",
  },
];

const STEPS = [
  {
    title: "Import",
    body: "Database exports and manual entries, deduplicated on arrival.",
  },
  {
    title: "Screen",
    body: "Titles and abstracts, then full texts, against your criteria.",
  },
  {
    title: "Snowball",
    body: "Citation search outward from everything that survived.",
  },
  {
    title: "Synthesize",
    body: "Read, excerpt, and build the concept matrix.",
  },
  {
    title: "Report",
    body: "PRISMA diagram, methods text, and exports.",
  },
];

export default function Home() {
  const configured = isSupabaseConfigured();

  return (
    <div className="flex flex-1 flex-col bg-zinc-50 font-sans dark:bg-zinc-950">
      <header className="mx-auto flex w-full max-w-5xl items-center justify-between px-6 py-5">
        <span className="text-lg font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
          SimpleSLR
        </span>
        {configured && (
          <nav className="flex items-center gap-2">
            <Link
              href="/login"
              className="rounded-full px-4 py-2 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              Sign in
            </Link>
            <Link
              href="/login"
              className="rounded-full bg-teal-700 px-4 py-2 text-sm font-medium text-zinc-50 transition-colors hover:bg-teal-800 dark:bg-teal-400 dark:text-teal-950 dark:hover:bg-teal-300"
            >
              Start a review
            </Link>
          </nav>
        )}
      </header>

      <main className="mx-auto w-full max-w-5xl flex-1 px-6">
        <section className="mx-auto max-w-3xl pt-14 pb-16 text-center sm:pt-20">
          <p className="mb-4 text-xs font-semibold uppercase tracking-widest text-teal-700 dark:text-teal-400">
            Free for research teams · No ads, no tracking
          </p>
          <h1 className="text-4xl font-semibold tracking-tight text-zinc-900 sm:text-5xl sm:leading-[1.1] dark:text-zinc-50">
            Systematic literature reviews, from search to synthesis
          </h1>
          <p className="mx-auto mt-5 max-w-2xl text-lg leading-8 text-zinc-600 dark:text-zinc-400">
            SimpleSLR is a collaborative tool for PRISMA 2020 screening,
            snowballing, and the Webster and Watson concept matrix.
            Everything your methods section needs, nothing your team has
            to pay for.
          </p>
          {configured ? (
            <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
              <Link
                href="/login"
                className="flex h-12 items-center rounded-full bg-teal-700 px-8 text-base font-medium text-zinc-50 transition-colors hover:bg-teal-800 dark:bg-teal-400 dark:text-teal-950 dark:hover:bg-teal-300"
              >
                Start a review
              </Link>
              <a
                href="#features"
                className="flex h-12 items-center rounded-full border border-zinc-300 px-8 text-base font-medium text-zinc-700 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
              >
                What is inside
              </a>
            </div>
          ) : (
            <div className="mx-auto mt-8 max-w-md rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200">
              Backend not configured yet. Add the Supabase environment
              variables described in SETUP.md, then redeploy.
            </div>
          )}
        </section>

        <section aria-label="How it works" className="border-y border-zinc-200 py-10 dark:border-zinc-800">
          <ol className="grid gap-6 sm:grid-cols-2 lg:grid-cols-5">
            {STEPS.map((s, i) => (
              <li key={s.title} className="flex gap-3 lg:flex-col lg:gap-2">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-teal-700 text-sm font-semibold text-teal-700 tabular-nums dark:border-teal-400 dark:text-teal-400">
                  {i + 1}
                </span>
                <div>
                  <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">
                    {s.title}
                  </h2>
                  <p className="mt-1 text-sm leading-6 text-zinc-600 dark:text-zinc-400">
                    {s.body}
                  </p>
                </div>
              </li>
            ))}
          </ol>
        </section>

        <section id="features" className="py-16">
          <h2 className="mb-8 text-center text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
            Built for the whole review, not just the screening
          </h2>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map((f) => (
              <div
                key={f.title}
                className="rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900"
              >
                <h3 className="mb-2 font-semibold text-zinc-900 dark:text-zinc-50">
                  {f.title}
                </h3>
                <p className="text-sm leading-6 text-zinc-600 dark:text-zinc-400">
                  {f.body}
                </p>
              </div>
            ))}
          </div>
        </section>

        {configured && (
          <section className="mb-16 rounded-2xl border border-zinc-200 bg-white px-6 py-10 text-center dark:border-zinc-800 dark:bg-zinc-900">
            <h2 className="text-xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
              Free forever
            </h2>
            <p className="mx-auto mt-2 max-w-xl text-sm leading-6 text-zinc-600 dark:text-zinc-400">
              Bring your own API key if you want the optional AI
              assistance, or use none at all. Either way, the review
              costs your team nothing.
            </p>
            <Link
              href="/login"
              className="mt-6 inline-flex h-11 items-center rounded-full bg-teal-700 px-8 text-sm font-medium text-zinc-50 transition-colors hover:bg-teal-800 dark:bg-teal-400 dark:text-teal-950 dark:hover:bg-teal-300"
            >
              Create your account
            </Link>
          </section>
        )}
      </main>
      <SiteFooter />
    </div>
  );
}
