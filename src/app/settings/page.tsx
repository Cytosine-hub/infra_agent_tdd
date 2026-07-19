import { redirect } from "next/navigation";
import { currentUser } from "@/lib/session";
import SettingsTabs from "@/components/SettingsTabs";
import RepoManager from "@/components/RepoManager";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const user = await currentUser();
  if (!user) redirect("/login");
  if (user.role === "member") redirect("/");
  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-2xl font-bold">设置</h1>
      <div className="mt-4">
        <SettingsTabs isAdmin={user.role === "admin"} />
      </div>
      <RepoManager />
    </div>
  );
}
