import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { addTeam, deleteTeam, getTeamById, listTeams, teamUsage } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { apiHandler, badRequest, forbidden } from "@/lib/api";

export const GET = apiHandler(async () => {
  return NextResponse.json({ teams: listTeams() });
});

const AddSchema = z.object({
  name: z.string().trim().min(2, "小组名至少 2 个字符").max(24, "小组名最长 24 个字符"),
});

// 小组是组织结构，仅管理员可维护
export const POST = apiHandler(async (req: NextRequest) => {
  const user = await requireUser();
  if (user.role !== "admin") return forbidden("仅管理员可维护小组");
  const parsed = AddSchema.safeParse(await req.json());
  if (!parsed.success) return badRequest(parsed.error.issues.map((i) => i.message).join("；"));
  return NextResponse.json({ team: addTeam(parsed.data.name) }, { status: 201 });
});

export const DELETE = apiHandler(async (req: NextRequest) => {
  const user = await requireUser();
  if (user.role !== "admin") return forbidden("仅管理员可维护小组");
  const id = Number(new URL(req.url).searchParams.get("id"));
  if (!id) return badRequest("缺少 id");
  const team = getTeamById(id);
  if (!team) return badRequest("小组不存在");
  const usage = teamUsage(team.name);
  if (usage.users > 0 || usage.requirements > 0) {
    return badRequest(
      `「${team.name}」仍被 ${usage.users} 个账号、${usage.requirements} 条需求使用，不能删除`
    );
  }
  deleteTeam(id);
  return NextResponse.json({ ok: true });
});
