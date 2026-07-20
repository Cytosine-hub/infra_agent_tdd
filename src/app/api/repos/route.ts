import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  addRepo,
  deleteRepo,
  getRepoById,
  listRepos,
  requeueRepoOnboard,
  setRepoToken,
  teamExists,
} from "@/lib/db";
import { requireUser } from "@/lib/session";
import { apiHandler, badRequest, forbidden } from "@/lib/api";
import { selectableRepos } from "@/lib/repo-access";

// ?forUser=1 时只返回当前用户可选用的仓库（公共 + 本组）
export const GET = apiHandler(async (req: NextRequest) => {
  const repos = listRepos();
  if (new URL(req.url).searchParams.get("forUser") === "1") {
    const user = await requireUser();
    return NextResponse.json({ repos: selectableRepos(repos, user) });
  }
  return NextResponse.json({ repos });
});

const AddSchema = z.object({
  fullName: z.string().regex(/^[\w.-]+\/[\w.-]+$/, "仓库格式应为 owner/repo"),
  description: z.string().default(""),
  team: z.string().default(""), // '' = 公共
  host: z.string().default("github.com"), // 代码托管主机
  token: z.string().default(""), // 该仓库专用访问令牌（可空则用全局）
});

// 仓库列表由组长/管理员维护
export const POST = apiHandler(async (req: NextRequest) => {
  const user = await requireUser();
  if (user.role === "member") return forbidden("仅组长或管理员可维护仓库列表");
  const parsed = AddSchema.safeParse(await req.json());
  if (!parsed.success) return badRequest(parsed.error.issues.map((i) => i.message).join("；"));
  if (parsed.data.team && !teamExists(parsed.data.team)) {
    return badRequest("归属小组不存在，请先在「小组管理」中添加");
  }
  // 保留协议前缀（HTTP-only 的自建 GitLab 需要 http://），仅去掉多余的结尾斜杠
  const host = (parsed.data.host || "github.com").replace(/\/+$/, "");
  const repo = addRepo(
    parsed.data.fullName,
    parsed.data.description,
    parsed.data.team,
    parsed.data.token,
    host
  );
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

// action=reonboard 重新入驻；action=set_token 更新/清除专用令牌
export const PATCH = apiHandler(async (req: NextRequest) => {
  const user = await requireUser();
  if (user.role === "member") return forbidden("仅组长或管理员可维护仓库列表");
  const body = (await req.json()) as { id?: number; action?: string; token?: string };
  if (!body.id || !getRepoById(body.id)) return badRequest("仓库不存在");
  if (body.action === "set_token") {
    setRepoToken(body.id, body.token ?? "");
  } else {
    requeueRepoOnboard(body.id);
  }
  return NextResponse.json({ repo: getRepoById(body.id) });
});
