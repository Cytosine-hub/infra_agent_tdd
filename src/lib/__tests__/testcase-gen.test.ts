import { describe, expect, it } from "vitest";
import { generateWithTemplate, testCasesToMarkdown } from "../testcase-gen";
import type { Requirement } from "../types";

const req: Requirement = {
  id: 1,
  title: "慢 SQL 展示页面",
  team: "数据库组",
  repo: "org/portal",
  priority: "P1",
  description: "展示 Top 10 慢 SQL",
  testScenarios: "- 选择最近 7 天展示对应数据\n- 无数据时展示空态",
  status: "requirement_approved",
  createdBy: "db_member",
  testCases: null,
  leadApprovedTests: 0,
  requesterApprovedTests: 0,
  githubIssueNumber: null,
  githubIssueUrl: null,
  branch: null,
  prNumber: null,
  prUrl: null,
  rejectReason: null,
  createdAt: "",
  updatedAt: "",
};

describe("generateWithTemplate", () => {
  it("需求方每条核心场景生成一条用例，并附带通用用例", () => {
    const cases = generateWithTemplate(req);
    expect(cases.length).toBe(5); // 2 条场景 + 正常路径 + 边界 + 权限
    expect(cases[0].title).toContain("最近 7 天");
    expect(cases[1].title).toContain("空态");
  });

  it("用例编号连续且唯一", () => {
    const cases = generateWithTemplate(req);
    const ids = cases.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids[0]).toBe("TC-01");
  });

  it("无核心场景时也生成基础用例", () => {
    const cases = generateWithTemplate({ ...req, testScenarios: "" });
    expect(cases.length).toBe(3);
  });
});

describe("testCasesToMarkdown", () => {
  it("输出包含编号、步骤和预期结果", () => {
    const md = testCasesToMarkdown(generateWithTemplate(req));
    expect(md).toContain("### TC-01");
    expect(md).toContain("**预期结果**");
    expect(md).toContain("1. ");
  });
});
