import AppHeader from "@/components/AppHeader";
import DashboardClient from "@/components/dashboard/DashboardClient";
import { requireUser } from "@/lib/requireUser";

export default async function DashboardPage() {
  const user = await requireUser();

  return (
    <div className="flex flex-1 flex-col bg-zinc-50 font-sans dark:bg-zinc-950">
      <AppHeader email={user.email} />
      <DashboardClient userId={user.id} />
    </div>
  );
}
