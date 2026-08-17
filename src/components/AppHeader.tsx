import Link from "next/link";

export default function AppHeader({
  email,
  projectName,
  projectId,
}: {
  email?: string | null;
  projectName?: string | null;
  projectId?: string | null;
}) {
  return (
    <header className="flex items-center justify-between border-b border-zinc-200 bg-white px-6 py-3 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex items-center gap-3 overflow-hidden">
        <Link
          href="/dashboard"
          className="shrink-0 text-lg font-semibold text-zinc-900 hover:text-zinc-600 dark:text-zinc-50 dark:hover:text-zinc-300"
        >
          SimpleSLR
        </Link>
        {projectName && projectId && (
          <>
            <span className="text-zinc-300 dark:text-zinc-700">/</span>
            <Link
              href={`/projects/${projectId}`}
              className="truncate text-sm font-medium text-zinc-700 hover:text-zinc-900 dark:text-zinc-300 dark:hover:text-zinc-100"
            >
              {projectName}
            </Link>
          </>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-4">
        {email && (
          <span className="hidden text-sm text-zinc-500 sm:inline dark:text-zinc-400">
            {email}
          </span>
        )}
        <form action="/auth/signout" method="post">
          <button
            type="submit"
            className="rounded-full border border-zinc-300 px-3 py-1 text-sm text-zinc-700 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            Sign out
          </button>
        </form>
      </div>
    </header>
  );
}
