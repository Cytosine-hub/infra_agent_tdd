import { describe, expect, it } from "vitest";
import { buildClassifyPrompt, buildPrompt, parseModuleSuggestion } from "../agent-runner";
import type { RepoModule, Requirement } from "../types";

const req: Requirement = {
  id: 8,
  title: "管理端增加审计列表",
  team: "数据库组",
  repo: "org/portal",
  priority: "P1",
  description: "在管理端增加审计记录列表与筛选。",
  testScenarios: "按操作者筛选",
  status: "testcases_approved",
  createdBy: "member",
  testCases: [],
  leadApprovedTests: 1,
  requesterApprovedTests: 1,
  githubIssueNumber: 21,
  githubIssueUrl: null,
  branch: "feature/req-8-issue-21",
  prNumber: null,
  prUrl: null,
  rejectReason: null,
  execPlan: null,
  guardStatus: "approved",
  guardReason: "",
  reviewVerdict: "",
  reviewFeedback: "",
  fixRounds: 0,
  moduleKey: "",
  scopePaths: [],
  moduleSuggestion: null,
  scopeLockedBy: "",
  scopeLockedAt: null,
  createdAt: "",
  updatedAt: "",
};

const modules: RepoModule[] = [
  {
    id: 1,
    repoId: 1,
    moduleKey: "admin-web",
    name: "管理端",
    paths: ["apps/admin/**"],
    description: "管理页面",
    confirmed: 1,
    sortOrder: 0,
  },
  {
    id: 2,
    repoId: 1,
    moduleKey: "shared",
    name: "公共",
    paths: ["packages/shared/**"],
    description: "共享代码",
    confirmed: 1,
    sortOrder: 10,
  },
];

describe("模块识别", () => {
  it("解析合法建议，缺省 scopePaths 时使用模块路径", () => {
    const suggestion = parseModuleSuggestion(
      '结果：{"moduleKey":"admin-web","rationale":"页面位于管理端","confidence":1.4,"scopePaths":[]}',
      modules
    );
    expect(suggestion.scopePaths).toEqual(["apps/admin/**"]);
    expect(suggestion.confidence).toBe(1);
  });

  it("拒绝模块地图之外的 key", () => {
    expect(() =>
      parseModuleSuggestion(
        '{"moduleKey":"unknown","rationale":"x","confidence":0.5,"scopePaths":["src/**"]}',
        modules
      )
    ).toThrow("未知 moduleKey");
  });

  it("提示词包含需求场景和完整模块地图", () => {
    const prompt = buildClassifyPrompt(req, modules);
    expect(prompt).toContain("按操作者筛选");
    expect(prompt).toContain("admin-web");
    expect(prompt).toContain("packages/shared/**");
  });

  it("仅在范围已锁定时把模块和路径注入开发提示", () => {
    expect(buildPrompt(req)).not.toContain("已锁定开发范围");
    const prompt = buildPrompt({
      ...req,
      moduleKey: "admin-web,shared",
      scopePaths: ["apps/admin/**", "packages/shared/audit/**"],
      scopeLockedBy: "lead",
      scopeLockedAt: "2026-07-21 10:00:00",
    });
    expect(prompt).toContain("【admin-web,shared】");
    expect(prompt).toContain("`packages/shared/audit/**`");
    expect(prompt).toContain("不得静默扩大范围");
  });
});
