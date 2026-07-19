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
    const task = latestAgentTask(id);
    if (!task) return NextResponse.json({ task: null, log: "" });
    // 服务重启后遗留的 running 任务：进程已不在则视为失败
    const effectiveStatus =
      task.status === "running" && !pidAlive(task.pid) && task.step === "develop"
        ? "failed"
        : task.status;
    return NextResponse.json({
      task: { ...task, status: effectiveStatus },
      log: readLogTail(task.logPath),
    });
  }
);
