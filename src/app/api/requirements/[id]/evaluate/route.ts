import { NextRequest, NextResponse } from "next/server";
import { getRequirement, updateRequirement, addEvent } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { apiHandler, badRequest, forbidden } from "@/lib/api";
import { evaluateExecPlan } from "@/lib/exec-planner";

// AI 评估执行方案（引擎/模型/推理强度）。同步调用本地 Claude（约 5-20 秒）。
export const POST = apiHandler(
  async (_req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const user = await requireUser();
    const id = Number((await ctx.params).id);
    const requirement = getRequirement(id);
    if (!requirement) return badRequest("需求不存在");
    const isLead =
      user.role === "admin" || (user.role === "lead" && user.team === requirement.team);
    if (!isLead) return forbidden("仅本组组长或管理员可评估执行方案");
    if (
      !["testcases_approved", "developing", "in_review"].includes(requirement.status)
    ) {
      return badRequest("仅在用例审核通过后可评估执行方案");
    }

    const plan = await evaluateExecPlan(requirement);
    updateRequirement(id, { execPlan: plan });
    addEvent(
      id,
      "plan_evaluated",
      user.username,
      `AI 评估执行方案：${plan.engine}/${plan.model}/${plan.effort} — ${plan.rationale}`
    );
    return NextResponse.json({ plan });
  }
);
