import AppHeader from "@/components/AppHeader";
import RecordsClient from "@/components/project/RecordsClient";
import { getProject } from "@/lib/getProject";

export default async function RecordsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { user, project } = await getProject(id);

  return (
    <div className="flex flex-1 flex-col bg-zinc-50 font-sans dark:bg-zinc-950">
      <AppHeader email={user.email} projectName={project.name} projectId={project.id} />
      <RecordsClient projectId={project.id} userId={user.id} />
    </div>
  );
}
