import { notFound, redirect } from "next/navigation";
import { getRequirement, listEvents } from "@/lib/db";
import { currentUser } from "@/lib/session";
import RequirementDetail from "@/components/RequirementDetail";

export const dynamic = "force-dynamic";

export default async function RequirementPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await currentUser();
  if (!user) redirect("/login");
  const id = Number((await params).id);
  const requirement = getRequirement(id);
  if (!requirement) notFound();
  return (
    <RequirementDetail
      initialRequirement={requirement}
      initialEvents={listEvents(id)}
      user={user}
    />
  );
}
