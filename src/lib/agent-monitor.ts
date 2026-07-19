import type { AgentRun, Requirement } from "./types";

// 从仓库最近的 workflow 运行中筛出与某需求相关的：
// - 运行分支等于需求分支（CI / PR Review 在 PR 分支上跑）
// - issues 事件触发且标题含该需求 Issue 的标题（Agent Develop 由打标签触发）
export function runsForRequirement(
  runs: AgentRun[],
  req: Pick<Requirement, "branch" | "title" | "githubIssueNumber">
): AgentRun[] {
  return runs.filter((r) => {
    if (req.branch && r.headBranch === req.branch) return true;
    if (
      r.event === "issues" &&
      (r.displayTitle.includes(req.title) ||
        (req.githubIssueNumber != null && r.displayTitle.includes(`#${req.githubIssueNumber}`)))
    ) {
      return true;
    }
    return false;
  });
}

export type AgentHealth = "idle" | "running" | "ok" | "failed";

// 汇总一组运行的整体健康度：有失败（最新一次结论非 success）→ failed
export function summarizeRuns(runs: AgentRun[]): AgentHealth {
  if (runs.length === 0) return "idle";
  if (runs.some((r) => r.status !== "completed")) return "running";
  // 每个 workflow 只看最新一次运行的结论
  const latestByName = new Map<string, AgentRun>();
  for (const r of runs) {
    const prev = latestByName.get(r.name);
    if (!prev || r.createdAt > prev.createdAt) latestByName.set(r.name, r);
  }
  for (const r of latestByName.values()) {
    if (r.conclusion !== "success") return "failed";
  }
  return "ok";
}

export const HEALTH_LABELS: Record<AgentHealth, string> = {
  idle: "暂无运行",
  running: "运行中",
  ok: "正常",
  failed: "有失败",
};
