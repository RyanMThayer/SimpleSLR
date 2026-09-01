import Link from "next/link";
import ThemeMenu from "@/components/ThemeMenu";

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
          className="shrink-0 font-serif text-lg font-semibold text-zinc-900 hover:text-zinc-600 dark:text-zinc-50 dark:hover:text-zinc-300"
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
        <ThemeMenu email={email} />
      </div>
    </header>
  );
}
