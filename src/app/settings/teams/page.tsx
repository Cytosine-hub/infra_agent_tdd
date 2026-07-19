import { redirect } from "next/navigation";
import { currentUser } from "@/lib/session";
import SettingsTabs from "@/components/SettingsTabs";
import TeamsManager from "@/components/TeamsManager";

export const dynamic = "force-dynamic";

export default async function TeamsSettingsPage() {
  const user = await currentUser();
  if (!user) redirect("/login");
  if (user.role !== "admin") redirect("/settings");
  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-2xl font-bold">设置</h1>
      <div className="mt-4">
        <SettingsTabs isAdmin />
      </div>
      <TeamsManager />
    </div>
  );
}
