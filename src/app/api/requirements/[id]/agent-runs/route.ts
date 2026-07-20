import { NextRequest, NextResponse } from "next/server";
import { getRequirement } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { apiHandler, badRequest } from "@/lib/api";
import { providerConfigured, listAgentRuns } from "@/lib/repo-provider";
import { summarizeRuns } from "@/lib/agent-monitor";

// 需求相关的 GitHub Actions 运行状态（Agent 监控数据源）
export const GET = apiHandler(
  async (_req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    await requireUser();
    const id = Number((await ctx.params).id);
    const requirement = getRequirement(id);
    if (!requirement) return badRequest("需求不存在");
    if (!providerConfigured(requirement.repo) || !requirement.githubIssueNumber) {
      return NextResponse.json({ runs: [], health: "idle" });
    }
    const runs = await listAgentRuns(requirement);
    return NextResponse.json({ runs, health: summarizeRuns(runs) });
  }
);
