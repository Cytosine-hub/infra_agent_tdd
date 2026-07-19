import { NextResponse } from "next/server";
import { getRequirement, listActiveAgentTasks } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { apiHandler } from "@/lib/api";
import { pidAlive } from "@/lib/agent-runner";

// 全局本地 Agent 任务列表（Agent 监控页数据源）
export const GET = apiHandler(async () => {
  await requireUser();
  const tasks = listActiveAgentTasks().map((t) => {
    const req = getRequirement(t.requirementId);
    // 仅对记录了子进程 pid 的执行步骤做探活；其余 running 状态由 runner 启动恢复兜底
    const status =
      t.status === "running" &&
      t.pid != null &&
      !pidAlive(t.pid) &&
      (t.step === "develop" || t.step === "review")
        ? "failed"
        : t.status;
    return {
      ...t,
      status,
      requirementTitle: req?.title ?? `#${t.requirementId}`,
      requirementTeam: req?.team ?? "",
      repo: req?.repo ?? "",
    };
  });
  return NextResponse.json({ tasks });
});
