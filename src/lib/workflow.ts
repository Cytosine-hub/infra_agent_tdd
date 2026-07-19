import type { Requirement, Role, Status, User } from "./types";

// 工作流动作定义。每个动作声明：允许的起始状态、允许的角色、附加校验。
export type Action =
  | "approve_requirement"
  | "reject_requirement"
  | "generate_tests"
  | "approve_tests"
  | "reject_tests"
  | "start_dev"
  | "retrigger_dev"
  | "review_pr"
  | "merge_pr"
  | "mark_in_review"
  | "mark_done";

interface ActionRule {
  from: Status[];
  roles: Role[] | "any";
  // 额外校验：返回错误信息表示拒绝，null 表示允许
  guard?: (req: Requirement, user: User) => string | null;
}

const sameTeamLead = (req: Requirement, user: User): string | null =>
  user.role === "admin" || (user.role === "lead" && user.team === req.team)
    ? null
    : "仅本组组长或管理员可执行此操作";

export const ACTION_RULES: Record<Action, ActionRule> = {
  approve_requirement: {
    from: ["submitted", "requirement_rejected"],
    roles: ["lead", "admin"],
    guard: sameTeamLead,
  },
  reject_requirement: {
    from: ["submitted"],
    roles: ["lead", "admin"],
    guard: sameTeamLead,
  },
  generate_tests: {
    from: ["requirement_approved", "testcases_rejected", "testcases_generated"],
    roles: "any",
    // 防滥用：仅本组组长/管理员或需求提交人可触发 AI 生成
    guard: (req, user) => {
      const isLead = sameTeamLead(req, user) === null;
      return isLead || user.username === req.createdBy
        ? null
        : "仅本组组长/管理员或需求提交人可生成测试用例";
    },
  },
  approve_tests: {
    from: ["testcases_generated"],
    roles: "any",
    guard: (req, user) => {
      const isLead = sameTeamLead(req, user) === null;
      const isRequester = user.username === req.createdBy;
      return isLead || isRequester ? null : "仅本组组长/管理员或需求提交人可审核测试用例";
    },
  },
  reject_tests: {
    from: ["testcases_generated"],
    roles: "any",
    guard: (req, user) => {
      const isLead = sameTeamLead(req, user) === null;
      const isRequester = user.username === req.createdBy;
      return isLead || isRequester ? null : "仅本组组长/管理员或需求提交人可驳回测试用例";
    },
  },
  start_dev: {
    from: ["testcases_approved"],
    roles: ["lead", "admin"],
    guard: sameTeamLead,
  },
  retrigger_dev: {
    from: ["developing", "in_review"],
    roles: ["lead", "admin"],
    guard: sameTeamLead,
  },
  review_pr: {
    from: ["in_review"],
    roles: ["lead", "admin"],
    guard: sameTeamLead,
  },
  merge_pr: {
    from: ["in_review"],
    roles: ["lead", "admin"],
    guard: sameTeamLead,
  },
  mark_in_review: { from: ["developing"], roles: "any" },
  mark_done: { from: ["in_review", "developing"], roles: "any" },
};

export function canPerform(action: Action, req: Requirement, user: User): string | null {
  const rule = ACTION_RULES[action];
  if (!rule.from.includes(req.status)) {
    return `当前状态（${req.status}）不允许执行该操作`;
  }
  if (rule.roles !== "any" && !rule.roles.includes(user.role)) {
    return "当前角色无权执行该操作";
  }
  return rule.guard ? rule.guard(req, user) : null;
}

// 测试用例双审：组长 + 需求方都通过后才进入 testcases_approved。
// 若提交人本身就是组长，一次通过即可。
export function nextTestApprovalState(
  req: Requirement,
  user: User
): { leadApprovedTests: 0 | 1; requesterApprovedTests: 0 | 1; status: Status } {
  const isLead = user.role === "admin" || (user.role === "lead" && user.team === req.team);
  const isRequester = user.username === req.createdBy;
  const lead = isLead ? 1 : req.leadApprovedTests;
  const requester = isRequester ? 1 : req.requesterApprovedTests;
  const requesterIsLead = isLead && isRequester;
  const approved = requesterIsLead ? lead === 1 : lead === 1 && requester === 1;
  return {
    leadApprovedTests: lead as 0 | 1,
    requesterApprovedTests: requester as 0 | 1,
    status: approved ? "testcases_approved" : "testcases_generated",
  };
}

export function branchNameFor(req: Requirement, issueNumber: number): string {
  return `feature/req-${req.id}-issue-${issueNumber}`;
}
