import { NextRequest, NextResponse } from "next/server";
import { getRequirement, latestAgentTask } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { apiHandler, badRequest } from "@/lib/api";
import { pidAlive, readLogTail } from "@/lib/agent-runner";

// 需求的本地 Agent 任务状态 + 实时日志尾部
export const GET = apiHandler(
  async (_req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    await requireUser();
    const id = Number((await ctx.params).id);
    if (!getRequirement(id)) return badRequest("需求不存在");
    const task = latestAgentTask(id, "develop");
    const review = latestAgentTask(id, "review");
    const testcases = latestAgentTask(id, "testcases");
    // 仅对记录了子进程 pid 的执行步骤做探活；其余 running 状态由 runner 启动恢复兜底
    const effective = (t: typeof task) =>
      t &&
      t.status === "running" &&
      t.pid != null &&
      !pidAlive(t.pid) &&
      (t.step === "develop" || t.step === "review")
        ? { ...t, status: "failed" as const }
        : t;
    return NextResponse.json({
      task: effective(task),
      log: task ? readLogTail(task.logPath) : "",
      review: effective(review),
      reviewLog: review ? readLogTail(review.logPath, 3000) : "",
      testcases: effective(testcases),
    });
  }
);
