import AppHeader from "@/components/AppHeader";
import ScreenClient from "@/components/project/ScreenClient";
import { getProject } from "@/lib/getProject";

export default async function ScreenPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ stage?: string }>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const { user, project } = await getProject(id);
  const initialStage =
    sp.stage === "full_text" ? ("full_text" as const) : ("title_abstract" as const);

  return (
    <div className="flex flex-1 flex-col bg-zinc-50 font-sans dark:bg-zinc-950">
      <AppHeader email={user.email} projectName={project.name} projectId={project.id} />
      <ScreenClient project={project} userId={user.id} initialStage={initialStage} />
    </div>
  );
}
