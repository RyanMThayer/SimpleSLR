import type { Metadata } from "next";
import Link from "next/link";
import SiteFooter from "@/components/SiteFooter";
import { REFERENCE_GROUPS, formatReference } from "@/lib/references";

export const metadata: Metadata = {
  title: "References · SimpleSLR",
  description:
    "The methodological literature SimpleSLR's review workflow is built on.",
};

/**
 * Public works-cited page. Every procedure in the tool traces to
 * published systematic review methodology; this page lists the
 * sources, grouped by what they ground, so review teams can cite
 * them in their manuscripts alongside the tool.
 */
export default function ReferencesPage() {
  return (
    <div className="flex flex-1 flex-col bg-zinc-50 font-sans dark:bg-zinc-950">
      <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-10">
        <Link
          href="/"
          className="text-sm text-zinc-500 underline-offset-4 hover:text-zinc-700 hover:underline dark:text-zinc-400 dark:hover:text-zinc-200"
        >
          &larr; SimpleSLR
        </Link>
        <h1 className="mt-5 font-serif text-3xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
          References
        </h1>
        <p className="mt-3 mb-8 text-sm leading-6 text-zinc-600 dark:text-zinc-400">
          SimpleSLR&apos;s workflow is not invented here: each procedure
          follows published systematic review methodology. These are the
          sources the process is built on, grouped by what they ground in
          the tool. The Report page inside a project cites them next to
          the procedures your review actually used, so you can carry the
          citations into your manuscript.
        </p>
        <div className="flex flex-col gap-8">
          {REFERENCE_GROUPS.map((group) => (
            <section key={group.title}>
              <h2 className="mb-3 font-serif text-lg font-semibold text-zinc-900 dark:text-zinc-50">
                {group.title}
              </h2>
              <ul className="flex flex-col gap-4">
                {group.refs.map((r) => (
                  <li
                    key={r.id}
                    id={r.id}
                    className="scroll-mt-6 border-l-2 border-zinc-200 pl-4 dark:border-zinc-800"
                  >
                    <p className="text-sm leading-6 text-zinc-800 dark:text-zinc-200">
                      {r.doi ? (
                        <>
                          {formatReference(r).replace(` doi:${r.doi}`, " ")}
                          <a
                            className="underline underline-offset-2"
                            href={`https://doi.org/${r.doi}`}
                            target="_blank"
                            rel="noreferrer"
                          >
                            doi:{r.doi}
                          </a>
                        </>
                      ) : r.url ? (
                        <>
                          {formatReference(r)}{" "}
                          <a
                            className="underline underline-offset-2"
                            href={r.url}
                            target="_blank"
                            rel="noreferrer"
                          >
                            link
                          </a>
                        </>
                      ) : (
                        formatReference(r)
                      )}
                    </p>
                    <p className="mt-1 text-[13px] leading-5 text-zinc-500 dark:text-zinc-400">
                      {r.note}
                    </p>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
