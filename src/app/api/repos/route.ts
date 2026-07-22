import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  addRepo,
  deleteRepo,
  getRepoById,
  listRepos,
  requeueRepoOnboard,
  setRepoHost,
  setRepoToken,
  teamExists,
} from "@/lib/db";
import { requireUser } from "@/lib/session";
import { apiHandler, badRequest, forbidden } from "@/lib/api";
import { selectableRepos } from "@/lib/repo-access";
import { removeRepoWorkspace } from "@/lib/cleanup";

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
  fullName: z.string().regex(/^[\w.-]+(\/[\w.-]+)+$/, "仓库格式应为 owner/repo（GitLab 可含子组）"),
  description: z.string().default(""),
  team: z.string().default(""), // '' = 公共
  provider: z.enum(["github", "gitlab"]).default("github"), // 托管类型
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
  const provider = parsed.data.provider;
  // GitHub 固定 github.com；GitLab 用填写的自建域名（保留协议前缀，HTTP-only 内网需 http://）
  const host =
    provider === "github"
      ? "github.com"
      : (parsed.data.host || "").replace(/\/+$/, "");
  if (provider === "gitlab" && !host) return badRequest("GitLab 仓库需填写自建域名（如 http://gitlab.内网）");
  if (provider === "gitlab" && !parsed.data.token) {
    return badRequest("GitLab 仓库需绑定专用访问令牌（用于 clone/建 Issue/MR/合并）");
  }
  const repo = addRepo(
    parsed.data.fullName,
    parsed.data.description,
    parsed.data.team,
    parsed.data.token,
    host,
    provider
  );
  return NextResponse.json({ repo }, { status: 201 });
});

export const DELETE = apiHandler(async (req: NextRequest) => {
  const user = await requireUser();
  if (user.role === "member") return forbidden("仅组长或管理员可维护仓库列表");
  const id = Number(new URL(req.url).searchParams.get("id"));
  if (!id) return badRequest("缺少 id");
  const repo = getRepoById(id);
  deleteRepo(id);
  if (repo) removeRepoWorkspace(repo.fullName); // 顺带清掉工作区，避免留孤儿
  return NextResponse.json({ ok: true });
});

// action=reonboard 重新入驻；action=set_token 更新/清除专用令牌；action=set_host 修改仓库地址
export const PATCH = apiHandler(async (req: NextRequest) => {
  const user = await requireUser();
  if (user.role === "member") return forbidden("仅组长或管理员可维护仓库列表");
  const body = (await req.json()) as { id?: number; action?: string; token?: string; host?: string };
  if (!body.id || !getRepoById(body.id)) return badRequest("仓库不存在");
  if (body.action === "set_token") {
    setRepoToken(body.id, body.token ?? "");
  } else if (body.action === "set_host") {
    const host = (body.host ?? "").trim().replace(/\/+$/, "");
    if (!host) return badRequest("仓库地址不能为空");
    setRepoHost(body.id, host);
  } else {
    requeueRepoOnboard(body.id);
  }
  return NextResponse.json({ repo: getRepoById(body.id) });
});
