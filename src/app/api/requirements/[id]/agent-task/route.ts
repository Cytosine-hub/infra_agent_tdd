import { NextRequest, NextResponse } from "next/server";
import { getRequirement, latestAgentTask, runnerOnline, type AgentTaskRow } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { apiHandler, badRequest } from "@/lib/api";
import { effectiveTaskStatus, readLogTail } from "@/lib/agent-runner";

// claude stream-json 行 → 人类可读的进度描述
/* eslint-disable @typescript-eslint/no-explicit-any */
function humanize(line: string): string {
  if (!line.startsWith("{")) return line.slice(0, 300);
  try {
    const j: any = JSON.parse(line);
    if (j.type === "system" && j.subtype === "init") return "会话启动，开始分析…";
    if (j.type === "assistant") {
      const blocks: any[] = j.message?.content ?? [];
      for (const b of blocks) {
        if (b.type === "tool_use") {
          const input = b.input ?? {};
          const target = input.file_path ?? input.path ?? input.command ?? input.pattern ?? "";
          return `🔧 ${b.name}${target ? "：" + String(target).slice(0, 160) : ""}`;
        }
        if (b.type === "text" && b.text?.trim()) return `💬 ${b.text.trim().slice(0, 200)}`;
      }
      return "思考中…";
    }
    if (j.type === "result") return j.is_error ? "❌ 执行出错" : "✅ agent 执行完成";
    if (j.type === "user") return "工具结果返回，继续…";
    return line.slice(0, 200);
  } catch {
    return line.slice(0, 300);
  }
}

// 从日志尾部取最后一条有意义的进度行（供前端“最新进度”展示）
function lastProgress(log: string): string {
  const lines = log
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^[-=\s]*$/.test(l));
  for (let i = lines.length - 1; i >= 0; i--) {
    const h = humanize(lines[i]);
    if (h && h !== "工具结果返回，继续…") return h;
  }
  return "";
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
    const mockup = latestAgentTask(id, "mockup");
    const classify = latestAgentTask(id, "classify");
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
      mockup: decorate(mockup, online),
      classify: decorate(classify, online),
    });
  }
);
