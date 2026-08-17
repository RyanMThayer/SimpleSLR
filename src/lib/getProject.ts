import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/requireUser";
import type { Project } from "@/lib/types";

/** Server side guard for project pages: signed in AND a member. */
export async function getProject(projectId: string) {
  const user = await requireUser();
  const supabase = await createClient();
  const { data: project } = await supabase
    .from("projects")
    .select("*")
    .eq("id", projectId)
    .maybeSingle();
  if (!project) {
    // Not a member (RLS hides it) or the project does not exist.
    redirect("/dashboard");
  }
  return { user, project: project as Project };
}
