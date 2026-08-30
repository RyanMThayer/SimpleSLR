/**
 * One muted line shown only while independent screening has papers mid
 * quota, so views gated on settled outcomes explain a missing paper
 * instead of silently omitting it. Renders nothing at zero, so classic
 * single opinion reviews never see it.
 */
export default function AwaitingNote({
  count,
  className = "",
}: {
  count: number;
  className?: string;
}) {
  if (count <= 0) return null;
  return (
    <p className={`text-sm text-zinc-500 dark:text-zinc-400 ${className}`}>
      {count === 1 ? "1 paper is" : `${count} papers are`} waiting on
      teammates&apos; independent screening and will show up here
      automatically when it finishes.
    </p>
  );
}
