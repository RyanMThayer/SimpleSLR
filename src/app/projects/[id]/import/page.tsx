import { redirect } from "next/navigation";

/** Importing now lives inside Discovery, per database. */
export default async function ImportPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  redirect(`/projects/${id}/discovery`);
}
