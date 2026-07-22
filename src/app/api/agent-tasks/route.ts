import { NextRequest, NextResponse } from "next/server";
import { getRequirement, listAgentTasksPage, runnerOnline } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { apiHandler } from "@/lib/api";
import { effectiveTaskStatus } from "@/lib/agent-runner";

// 全局本地 Agent 任务列表（Agent 监控页数据源）。
// 按时间倒序分页：?limit=N&before=<id>（取 id 小于 before 的更旧一页），返回 hasMore。
export const GET = apiHandler(async (req: NextRequest) => {
  await requireUser();
  const online = runnerOnline(Date.now());
  const url = new URL(req.url);
  const limit = Number(url.searchParams.get("limit") ?? 30);
  const beforeRaw = url.searchParams.get("before");
  const before = beforeRaw ? Number(beforeRaw) : undefined;
  const { tasks: rows, hasMore } = listAgentTasksPage(limit, before);
  const tasks = rows.map((t) => {
    const requirement = getRequirement(t.requirementId);
    const eff = effectiveTaskStatus(t, online);
    return {
      ...t,
      status: eff.status,
      interrupted: eff.interrupted,
      requirementTitle: requirement?.title ?? `#${t.requirementId}`,
      requirementTeam: requirement?.team ?? "",
      repo: requirement?.repo ?? "",
    };
  });
  return NextResponse.json({ runnerOnline: online, tasks, hasMore });
});
