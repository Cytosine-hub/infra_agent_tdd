import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { addRepo, deleteRepo, listRepos } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { apiHandler, badRequest, forbidden } from "@/lib/api";

export const GET = apiHandler(async () => {
  return NextResponse.json({ repos: listRepos() });
});

const AddSchema = z.object({
  fullName: z
    .string()
    .regex(/^[\w.-]+\/[\w.-]+$/, "仓库格式应为 owner/repo"),
  description: z.string().default(""),
});

// 仓库列表由组长/管理员维护
export const POST = apiHandler(async (req: NextRequest) => {
  const user = await requireUser();
  if (user.role === "member") return forbidden("仅组长或管理员可维护仓库列表");
  const parsed = AddSchema.safeParse(await req.json());
  if (!parsed.success) return badRequest(parsed.error.issues.map((i) => i.message).join("；"));
  const repo = addRepo(parsed.data.fullName, parsed.data.description);
  return NextResponse.json({ repo }, { status: 201 });
});

export const DELETE = apiHandler(async (req: NextRequest) => {
  const user = await requireUser();
  if (user.role === "member") return forbidden("仅组长或管理员可维护仓库列表");
  const id = Number(new URL(req.url).searchParams.get("id"));
  if (!id) return badRequest("缺少 id");
  deleteRepo(id);
  return NextResponse.json({ ok: true });
});
