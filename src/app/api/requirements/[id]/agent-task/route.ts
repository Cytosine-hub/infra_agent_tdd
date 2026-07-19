import { NextRequest, NextResponse } from "next/server";
import { getRequirement, latestAgentTask, runnerOnline, type AgentTaskRow } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { apiHandler, badRequest } from "@/lib/api";
import { effectiveTaskStatus, readLogTail } from "@/lib/agent-runner";

// 从日志尾部取最后一条有意义的进度行（供前端“最新进度”展示）
function lastProgress(log: string): string {
  const lines = log
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^[-=\s]*$/.test(l));
  return lines.length ? lines[lines.length - 1].slice(0, 300) : "";
}

function decorate(task: AgentTaskRow | null, online: boolean) {
  if (!task) return null;
  const eff = effectiveTaskStatus(task, online);
  return {
    ...task,
    status: eff.status,
    interrupted: eff.interrupted,
    error:
      eff.interrupted && !task.error
        ? online
          ? "执行子进程已中断"
          : "执行器（runner）离线，任务中断"
        : task.error,
  };
}

// 需求的本地 Agent 任务状态 + 实时日志尾部 + 最新进度 + 执行器在线状态
export const GET = apiHandler(
  async (_req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    await requireUser();
    const id = Number((await ctx.params).id);
    if (!getRequirement(id)) return badRequest("需求不存在");
    const online = runnerOnline(Date.now());
    const task = latestAgentTask(id, "develop");
    const review = latestAgentTask(id, "review");
    const testcases = latestAgentTask(id, "testcases");
    const log = task ? readLogTail(task.logPath) : "";
    const reviewLog = review ? readLogTail(review.logPath, 3000) : "";
    return NextResponse.json({
      runnerOnline: online,
      task: decorate(task, online),
      log,
      progress: lastProgress(log),
      review: decorate(review, online),
      reviewLog,
      reviewProgress: lastProgress(reviewLog),
      testcases: decorate(testcases, online),
    });
  }
);
