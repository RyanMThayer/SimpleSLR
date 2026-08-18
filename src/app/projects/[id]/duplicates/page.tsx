import AppHeader from "@/components/AppHeader";
import DuplicatesClient from "@/components/project/DuplicatesClient";
import { getProject } from "@/lib/getProject";

export default async function DuplicatesPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { user, project } = await getProject(id);

  return (
    <div className="flex flex-1 flex-col bg-zinc-50 font-sans dark:bg-zinc-950">
      <AppHeader email={user.email} projectName={project.name} projectId={project.id} />
      <DuplicatesClient projectId={project.id} userId={user.id} />
    </div>
  );
}
