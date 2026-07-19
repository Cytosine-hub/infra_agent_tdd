import { NextResponse } from "next/server";
import { getRequirement, listActiveAgentTasks, runnerOnline } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { apiHandler } from "@/lib/api";
import { effectiveTaskStatus } from "@/lib/agent-runner";

// 全局本地 Agent 任务列表（Agent 监控页数据源）
export const GET = apiHandler(async () => {
  await requireUser();
  const online = runnerOnline(Date.now());
  const tasks = listActiveAgentTasks().map((t) => {
    const req = getRequirement(t.requirementId);
    const eff = effectiveTaskStatus(t, online);
    return {
      ...t,
      status: eff.status,
      interrupted: eff.interrupted,
      requirementTitle: req?.title ?? `#${t.requirementId}`,
      requirementTeam: req?.team ?? "",
      repo: req?.repo ?? "",
    };
  });
  return NextResponse.json({ runnerOnline: online, tasks });
});
