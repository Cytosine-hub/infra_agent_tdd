import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { addEvent, getRepoByName, getRequirement, listEvents, updateRequirement } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { apiHandler, badRequest, forbidden } from "@/lib/api";
import { canUseRepo } from "@/lib/repo-access";
import { enqueueClassifyTask, enqueueMockupTask } from "@/lib/agent-runner";

export const GET = apiHandler(
  async (_req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const id = Number((await ctx.params).id);
    const requirement = getRequirement(id);
    if (!requirement) return badRequest("需求不存在");
    return NextResponse.json({ requirement, events: listEvents(id) });
  }
);

const EditSchema = z.object({
  title: z.string().min(2, "标题至少 2 个字符").max(120),
  team: z.string().min(1, "必须选择所属小组"),
  repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/, "必须选择目标仓库"),
  priority: z.enum(["P0", "P1", "P2"]),
  description: z.string().min(10, "需求描述至少 10 个字符"),
  testScenarios: z.string().default(""),
});

// 编辑需求：待审核状态可修改；被驳回状态修改后自动重新提交（回到待审核）
export const PATCH = apiHandler(
  async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const user = await requireUser();
    const id = Number((await ctx.params).id);
    const requirement = getRequirement(id);
    if (!requirement) return badRequest("需求不存在");

    if (!["submitted", "requirement_rejected"].includes(requirement.status)) {
      return badRequest("仅待审核或被驳回的需求可以修改");
    }
    const canEdit =
      user.username === requirement.createdBy ||
      user.role === "admin" ||
      (user.role === "lead" && user.team === requirement.team);
    if (!canEdit) return forbidden("仅需求提交人或本组组长可修改需求");

    const parsed = EditSchema.safeParse(await req.json());
    if (!parsed.success) return badRequest(parsed.error.issues.map((i) => i.message).join("；"));
    const repo = getRepoByName(parsed.data.repo);
    if (!repo) return badRequest("目标仓库不在系统仓库列表中");
    const deniedRepo = canUseRepo(repo, user);
    if (deniedRepo) return badRequest(deniedRepo);

    const resubmit = requirement.status === "requirement_rejected";
    updateRequirement(id, {
      ...parsed.data,
      status: "submitted",
      rejectReason: null,
      // 内容已变化：安全门审结论重置，下次 AI 任务重新审
      guardStatus: "",
      guardReason: "",
      moduleKey: "",
      scopePaths: [],
      moduleSuggestion: "",
      scopeLockedBy: "",
      scopeLockedAt: null,
    });
    addEvent(
      id,
      resubmit ? "resubmitted" : "edited",
      user.username,
      resubmit ? "修改需求内容并重新提交审核" : "修改需求内容"
    );
    // 内容变了 → 渲染图重新生成（best-effort）
    try {
      enqueueMockupTask(id);
    } catch {
      /* 已有进行中的渲染图任务则跳过 */
    }
    try {
      enqueueClassifyTask(id);
    } catch {
      /* 已有进行中的识别任务则跳过 */
    }
    return NextResponse.json({ requirement: getRequirement(id) });
  }
);
