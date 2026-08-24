import Link from "next/link";
import { isSupabaseConfigured } from "@/lib/supabase/server";

export default function Home() {
  const configured = isSupabaseConfigured();

  return (
    <div className="flex flex-1 flex-col items-center justify-center bg-zinc-50 px-6 font-sans dark:bg-zinc-950">
      <main className="flex w-full max-w-2xl flex-col items-center gap-6 text-center">
        <h1 className="text-5xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
          SimpleSLR
        </h1>
        <p className="max-w-lg text-lg leading-8 text-zinc-600 dark:text-zinc-400">
          Systematic literature reviews for teams. PRISMA screening,
          snowballing, and the Webster and Watson concept matrix.
        </p>
        {configured ? (
          <Link
            href="/login"
            className="flex h-12 items-center justify-center rounded-full bg-teal-700 px-8 text-base font-medium text-zinc-50 transition-colors hover:bg-teal-800 dark:bg-teal-400 dark:text-teal-950 dark:hover:bg-teal-300"
          >
            Go
          </Link>
        ) : (
          <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200">
            Backend not configured yet. Add the Supabase environment variables
            described in SETUP.md, then redeploy.
          </div>
        )}
      </main>
    </div>
  );
}
