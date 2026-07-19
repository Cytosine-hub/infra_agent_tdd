import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createRequirement, listRequirements, repoExists } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { apiHandler, badRequest } from "@/lib/api";

export const GET = apiHandler(async () => {
  return NextResponse.json({ requirements: listRequirements() });
});

const CreateSchema = z.object({
  title: z.string().min(2, "标题至少 2 个字符").max(120),
  team: z.string().min(1, "必须选择所属小组"),
  repo: z
    .string("必须选择目标仓库")
    .regex(/^[\w.-]+\/[\w.-]+$/, "必须选择目标仓库（owner/repo）"),
  priority: z.enum(["P0", "P1", "P2"]),
  description: z.string().min(10, "需求描述至少 10 个字符"),
  testScenarios: z.string().default(""),
});

export const POST = apiHandler(async (req: NextRequest) => {
  const user = await requireUser();
  const parsed = CreateSchema.safeParse(await req.json());
  if (!parsed.success) {
    return badRequest(parsed.error.issues.map((i) => i.message).join("；"));
  }
  // 防滥用：仓库必须在系统「仓库管理」白名单内（执行侧还会再验一次）
  if (!repoExists(parsed.data.repo)) {
    return badRequest("目标仓库不在系统仓库列表中，请联系组长/管理员在「仓库管理」中添加");
  }
  const requirement = createRequirement({ ...parsed.data, createdBy: user.username });
  return NextResponse.json({ requirement }, { status: 201 });
});
