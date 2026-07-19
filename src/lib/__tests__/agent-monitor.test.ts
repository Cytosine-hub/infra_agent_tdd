import { describe, expect, it } from "vitest";
import { runsForRequirement, summarizeRuns } from "../agent-monitor";
import type { AgentRun } from "../types";

function makeRun(patch: Partial<AgentRun>): AgentRun {
  return {
    id: 1,
    name: "CI",
    displayTitle: "",
    headBranch: "main",
    event: "pull_request",
    status: "completed",
    conclusion: "success",
    htmlUrl: "",
    createdAt: "2026-07-19T00:00:00Z",
    updatedAt: "2026-07-19T00:00:00Z",
    ...patch,
  };
}

const req = { branch: "feature/req-1-issue-7", title: "慢 SQL 展示页面", githubIssueNumber: 7 };

describe("runsForRequirement", () => {
  it("匹配需求分支上的运行", () => {
    const runs = [makeRun({ headBranch: "feature/req-1-issue-7" }), makeRun({ headBranch: "main" })];
    expect(runsForRequirement(runs, req)).toHaveLength(1);
  });

  it("匹配 issues 事件触发且标题含需求标题的运行", () => {
    const runs = [
      makeRun({ event: "issues", displayTitle: "[数据库组] 慢 SQL 展示页面" }),
      makeRun({ event: "issues", displayTitle: "其他无关 Issue" }),
      makeRun({ event: "push", displayTitle: "慢 SQL 展示页面" }),
    ];
    expect(runsForRequirement(runs, req)).toHaveLength(1);
  });
});

describe("summarizeRuns", () => {
  it("无运行为 idle，有未完成为 running", () => {
    expect(summarizeRuns([])).toBe("idle");
    expect(summarizeRuns([makeRun({ status: "in_progress", conclusion: null })])).toBe("running");
  });

  it("最新一次失败为 failed，即使更早一次成功", () => {
    const runs = [
      makeRun({ name: "Agent Develop", conclusion: "success", createdAt: "2026-07-19T01:00:00Z" }),
      makeRun({ name: "Agent Develop", conclusion: "failure", createdAt: "2026-07-19T02:00:00Z" }),
    ];
    expect(summarizeRuns(runs)).toBe("failed");
  });

  it("最新一次成功覆盖更早的失败", () => {
    const runs = [
      makeRun({ name: "Agent Develop", conclusion: "failure", createdAt: "2026-07-19T01:00:00Z" }),
      makeRun({ name: "Agent Develop", conclusion: "success", createdAt: "2026-07-19T02:00:00Z" }),
    ];
    expect(summarizeRuns(runs)).toBe("ok");
  });

  it("多个 workflow 任一失败即 failed", () => {
    const runs = [
      makeRun({ name: "CI", conclusion: "success" }),
      makeRun({ name: "Claude PR Review", conclusion: "cancelled" }),
    ];
    expect(summarizeRuns(runs)).toBe("failed");
  });
});
