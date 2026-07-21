import { NextRequest, NextResponse } from "next/server";
import { getRepoById, repoModuleMapStatus, requestRepoModuleMap } from "@/lib/db";
import { apiHandler, badRequest, forbidden } from "@/lib/api";
import { requireUser } from "@/lib/session";
import type { User } from "@/lib/types";

function canManageRepoModules(user: User): boolean {
  return user.role === "lead" || user.role === "admin";
}

// 轻量"AI 重新生成模块地图"：入队一个仓库级任务，由 runner 复用已有 workspace+索引生成，
// 不重建索引、不碰 agent.md。返回当前状态供前端轮询。
export const POST = apiHandler(
  async (_req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const user = await requireUser();
    if (!canManageRepoModules(user)) return forbidden("仅组长或管理员可生成模块地图");
    const repoId = Number((await ctx.params).id);
    const repo = getRepoById(repoId);
    if (!repo) return badRequest("仓库不存在");
    if (repo.onboardStatus !== "ready") {
      return badRequest("仓库尚未完成入驻，暂不能生成模块地图");
    }
    const status = repoModuleMapStatus(repoId);
    if (status === "queued" || status === "running") {
      return NextResponse.json({ status }); // 已在进行中，幂等
    }
    requestRepoModuleMap(repoId);
    return NextResponse.json({ status: "queued" });
  }
);
