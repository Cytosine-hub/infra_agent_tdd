import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  addEvent,
  getRepoByName,
  getRequirement,
  listRepoModules,
  lockRequirementScope,
  repoModuleMapConfirmed,
} from "@/lib/db";
import { apiHandler, badRequest, forbidden } from "@/lib/api";
import { requireUser } from "@/lib/session";
import { isRepoRelativeGlob, normalizeRepoPaths } from "@/lib/module-map";

const LockScopeSchema = z.object({
  moduleKeys: z
    .array(z.string().regex(/^[a-z0-9][a-z0-9_-]*$/))
    .min(1, "至少选择一个模块")
    .max(20),
  scopePaths: z
    .array(z.string().min(1).max(300))
    .min(1, "允许路径不能为空")
    .max(100)
    .refine((paths) => paths.every(isRepoRelativeGlob), "允许路径必须是仓库相对 glob，不能包含绝对路径或 .."),
});

const LOCKABLE_STATUSES = new Set([
  "submitted",
  "requirement_rejected",
  "requirement_approved",
  "testcases_generated",
  "testcases_rejected",
  "testcases_approved",
]);

export const PATCH = apiHandler(
  async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const user = await requireUser();
    const requirementId = Number((await ctx.params).id);
    const requirement = getRequirement(requirementId);
    if (!requirement) return badRequest("需求不存在");
    const isLead =
      user.role === "admin" || (user.role === "lead" && user.team === requirement.team);
    if (!isLead) return forbidden("仅本组组长或管理员可确认模块归属与开发范围");
    if (!LOCKABLE_STATUSES.has(requirement.status)) return badRequest("开发启动后不能修改已锁定范围");

    const parsed = LockScopeSchema.safeParse(await req.json());
    if (!parsed.success) return badRequest(parsed.error.issues.map((issue) => issue.message).join("；"));
    const repo = getRepoByName(requirement.repo);
    if (!repo) return badRequest("需求所属仓库不存在");
    if (!repoModuleMapConfirmed(repo.id)) return badRequest("仓库模块地图尚未确认，请先在仓库管理中确认");
    const modules = listRepoModules(repo.id, true);
    const moduleKeys = Array.from(new Set(parsed.data.moduleKeys));
    if (moduleKeys.some((key) => !modules.some((module) => module.moduleKey === key))) {
      return badRequest("选择的模块不在该仓库已确认模块地图中");
    }
    const scopePaths = normalizeRepoPaths(parsed.data.scopePaths);
    lockRequirementScope(requirementId, moduleKeys, scopePaths, user.username);
    addEvent(
      requirementId,
      "scope_locked",
      user.username,
      `锁定模块 ${moduleKeys.join("、")}；允许路径 ${scopePaths.join("、")}`
    );
    return NextResponse.json({ requirement: getRequirement(requirementId) });
  }
);
