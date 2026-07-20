// 需求全生命周期状态机的状态定义
export const STATUSES = [
  "submitted", // 已提交，待组长审核
  "requirement_rejected", // 需求被驳回
  "requirement_approved", // 需求审核通过，待生成测试用例
  "testcases_generated", // 测试用例已生成，待组长+需求方审核
  "testcases_rejected", // 测试用例被驳回，可重新生成
  "testcases_approved", // 测试用例审核通过，可启动开发
  "developing", // 已建 GitHub Issue，agent 开发中
  "in_review", // PR 已创建，CI + Claude 审查中
  "done", // PR 已合并
  "abandoned", // 已废弃（如多轮修复未过审查，需求需拆解后重新提交）
] as const;

export type Status = (typeof STATUSES)[number];

export const STATUS_LABELS: Record<Status, string> = {
  submitted: "待审核",
  requirement_rejected: "需求驳回",
  requirement_approved: "待生成用例",
  testcases_generated: "用例待审核",
  testcases_rejected: "用例驳回",
  testcases_approved: "待启动开发",
  developing: "开发中",
  in_review: "PR 审查中",
  done: "已完成",
  abandoned: "已废弃",
};

export type Role = "member" | "lead" | "admin";

export const ROLE_LABELS: Record<Role, string> = {
  member: "组员",
  lead: "组长",
  admin: "管理员",
};

export type AuthProvider = "local" | "github" | "gitlab";

export interface User {
  id: number;
  username: string;
  displayName: string;
  role: Role;
  team: string;
  provider: AuthProvider;
  providerLogin: string;
}

// GitHub Actions 中一次 agent/CI 工作流运行的状态快照
export interface AgentRun {
  id: number;
  name: string; // workflow 名，如 Agent Develop / CI / Claude PR Review
  displayTitle: string;
  headBranch: string;
  event: string;
  status: "queued" | "in_progress" | "completed" | string;
  conclusion: string | null; // success / failure / cancelled / timed_out …
  htmlUrl: string;
  createdAt: string;
  updatedAt: string;
}

export interface TestCase {
  id: string;
  title: string;
  precondition: string;
  steps: string[];
  expected: string;
}

export interface Repo {
  id: number;
  fullName: string; // owner/repo
  description: string;
  team: string; // '' = 公共仓库；否则仅该小组成员可选用
  // 入驻状态：ready 可用 / pending 待入驻 / indexing 入驻中 / failed 失败
  onboardStatus: "ready" | "pending" | "indexing" | "failed";
  onboardStep: string;
  onboardError: string;
  onboardPr: string; // agent.md PR 链接（如有）
  indexedAt: string | null;
  hasToken: boolean; // 是否绑定了专用 token（不暴露明文）
  host: string; // 代码托管主机（github.com 或自建 GitLab 域名）
}

// 启动开发前的执行方案（AI 评估 + 人工可改）
export interface ExecPlan {
  engine: string; // claude | codex
  model: string;
  effort: "low" | "medium" | "high";
  rationale: string; // 评估理由
  source: "ai" | "manual" | "default";
}

export interface Requirement {
  id: number;
  title: string;
  team: string;
  repo: string; // 绑定的目标仓库 owner/repo
  priority: "P0" | "P1" | "P2";
  description: string;
  testScenarios: string; // 提交人给出的核心测试场景
  status: Status;
  createdBy: string;
  testCases: TestCase[] | null;
  leadApprovedTests: 0 | 1;
  requesterApprovedTests: 0 | 1;
  githubIssueNumber: number | null;
  githubIssueUrl: string | null;
  branch: string | null;
  prNumber: number | null;
  prUrl: string | null;
  rejectReason: string | null;
  execPlan: ExecPlan | null;
  // AI 安全门审：'' 未审 / approved 通过 / rejected 拒绝（拒绝后所有 Agent 任务不执行）
  guardStatus: "" | "approved" | "rejected";
  guardReason: string;
  // PR 审查闭环：结论 + 意见 + 已自动修复轮次
  reviewVerdict: "" | "approved" | "changes";
  reviewFeedback: string;
  fixRounds: number;
  createdAt: string;
  updatedAt: string;
}

export interface RequirementEvent {
  id: number;
  requirementId: number;
  type: string;
  actor: string;
  detail: string;
  createdAt: string;
}

