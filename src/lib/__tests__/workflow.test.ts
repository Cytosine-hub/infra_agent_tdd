import { describe, expect, it } from "vitest";
import { branchNameFor, canPerform, nextTestApprovalState } from "../workflow";
import type { Requirement, User } from "../types";

function makeReq(patch: Partial<Requirement> = {}): Requirement {
  return {
    id: 1,
    title: "测试需求",
    team: "数据库组",
    repo: "org/portal",
    priority: "P1",
    description: "描述",
    testScenarios: "",
    status: "submitted",
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
    ...patch,
  };
}

const dbLead: User = { id: 1, username: "db_lead", displayName: "", role: "lead", team: "数据库组" };
const mwLead: User = { id: 2, username: "mw_lead", displayName: "", role: "lead", team: "中间件组" };
const member: User = { id: 3, username: "db_member", displayName: "", role: "member", team: "数据库组" };
const admin: User = { id: 4, username: "admin", displayName: "", role: "admin", team: "平台" };

describe("canPerform", () => {
  it("本组组长可审核需求", () => {
    expect(canPerform("approve_requirement", makeReq(), dbLead)).toBeNull();
  });

  it("其他组组长不可审核需求", () => {
    expect(canPerform("approve_requirement", makeReq(), mwLead)).not.toBeNull();
  });

  it("管理员可跨组审核", () => {
    expect(canPerform("approve_requirement", makeReq(), admin)).toBeNull();
  });

  it("组员不可审核需求", () => {
    expect(canPerform("approve_requirement", makeReq(), member)).not.toBeNull();
  });

  it("状态不符时拒绝操作", () => {
    expect(canPerform("start_dev", makeReq({ status: "submitted" }), dbLead)).not.toBeNull();
    expect(canPerform("start_dev", makeReq({ status: "testcases_approved" }), dbLead)).toBeNull();
  });

  it("需求提交人可审核测试用例", () => {
    const req = makeReq({ status: "testcases_generated", createdBy: "db_member" });
    expect(canPerform("approve_tests", req, member)).toBeNull();
  });

  it("无关人员不可审核测试用例", () => {
    const req = makeReq({ status: "testcases_generated", createdBy: "someone_else" });
    expect(canPerform("approve_tests", req, member)).not.toBeNull();
  });
});

describe("nextTestApprovalState 双审逻辑", () => {
  it("仅组长通过时保持待审核", () => {
    const req = makeReq({ status: "testcases_generated", createdBy: "db_member" });
    const next = nextTestApprovalState(req, dbLead);
    expect(next.leadApprovedTests).toBe(1);
    expect(next.status).toBe("testcases_generated");
  });

  it("组长和需求方都通过后进入 testcases_approved", () => {
    const req = makeReq({
      status: "testcases_generated",
      createdBy: "db_member",
      leadApprovedTests: 1,
    });
    const next = nextTestApprovalState(req, member);
    expect(next.requesterApprovedTests).toBe(1);
    expect(next.status).toBe("testcases_approved");
  });

  it("提交人本身是组长时一次通过即可", () => {
    const req = makeReq({ status: "testcases_generated", createdBy: "db_lead" });
    const next = nextTestApprovalState(req, dbLead);
    expect(next.status).toBe("testcases_approved");
  });
});

describe("abandon（需求废弃）", () => {
  it("本组组长可在进行中状态废弃", () => {
    expect(canPerform("abandon", makeReq({ status: "in_review" }), dbLead)).toBeNull();
    expect(canPerform("abandon", makeReq({ status: "developing" }), dbLead)).toBeNull();
  });
  it("已完成不可废弃；他组组长/组员不可废弃", () => {
    expect(canPerform("abandon", makeReq({ status: "done" }), dbLead)).not.toBeNull();
    expect(canPerform("abandon", makeReq({ status: "in_review" }), mwLead)).not.toBeNull();
    expect(canPerform("abandon", makeReq({ status: "in_review" }), member)).not.toBeNull();
  });
});

describe("branchNameFor", () => {
  it("分支名包含需求 ID 与 issue 号，保证唯一", () => {
    expect(branchNameFor(makeReq({ id: 42 }), 7)).toBe("feature/req-42-issue-7");
  });
});
