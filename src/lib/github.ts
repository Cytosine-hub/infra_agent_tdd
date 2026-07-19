import { Octokit } from "@octokit/rest";
import type { AgentRun, Requirement } from "./types";
import { testCasesToMarkdown } from "./testcase-gen";
import { branchNameFor } from "./workflow";
import { runsForRequirement } from "./agent-monitor";

// 每个需求绑定自己的目标仓库（requirement.repo，owner/repo 格式）。
// 全局只需配置一个有各仓库权限的 GITHUB_TOKEN。
export function githubConfigured(): boolean {
  return Boolean(process.env.GITHUB_TOKEN);
}

function parseRepo(fullName: string): { owner: string; repo: string } {
  const [owner, name] = (fullName ?? "").split("/");
  if (!owner || !name) throw new Error(`需求绑定的仓库格式错误：「${fullName}」，应为 owner/repo`);
  return { owner, repo: name };
}

function octokit(): Octokit {
  return new Octokit({ auth: process.env.GITHUB_TOKEN });
}

export const AGENT_LABEL = "agent:develop";

// 为需求创建 GitHub Issue，body 中带上完整需求 + 审核通过的测试用例。
// 打上 agent:develop 标签后，目标仓库的 GitHub Action（claude-code-action）会接管开发。
export async function createIssueForRequirement(req: Requirement): Promise<{
  issueNumber: number;
  issueUrl: string;
  branch: string;
}> {
  const gh = octokit();
  const { owner, repo: name } = parseRepo(req.repo);

  const body = [
    `> 由需求门户自动创建 · 门户需求 #${req.id} · 小组：${req.team} · 优先级：${req.priority} · 提交人：${req.createdBy}`,
    "",
    "## 需求描述",
    "",
    req.description,
    "",
    "## 验收测试用例（已审核通过，开发完成后必须逐条验证）",
    "",
    testCasesToMarkdown(req.testCases ?? []),
    "",
    "## 开发约定",
    "",
    "- 在独立分支上开发（分支名见下方评论），完成后向主分支提交 PR，PR 描述中引用本 Issue（`Closes #<本 issue 号>`）",
    "- 严格遵循本仓库根目录 agent.md 中的开发规范",
    "- 所有验收测试用例必须有对应的自动化测试并通过",
  ].join("\n");

  const issue = await gh.issues.create({
    owner,
    repo: name,
    title: `[${req.team}] ${req.title}`,
    body,
    labels: [AGENT_LABEL, `team:${req.team}`, `priority:${req.priority}`],
  });

  const branch = branchNameFor(req, issue.data.number);
  await gh.issues.createComment({
    owner,
    repo: name,
    issue_number: issue.data.number,
    body: `开发分支：\`${branch}\``,
  });

  return {
    issueNumber: issue.data.number,
    issueUrl: issue.data.html_url,
    branch,
  };
}

// 拉取与需求相关的 GitHub Actions 运行状态（Agent Develop / CI / Claude PR Review），
// 用于监控 agent 是否中断/失败
export async function listAgentRuns(req: Requirement): Promise<AgentRun[]> {
  const gh = octokit();
  const { owner, repo: name } = parseRepo(req.repo);
  const res = await gh.actions.listWorkflowRunsForRepo({
    owner,
    repo: name,
    per_page: 60,
  });
  const runs: AgentRun[] = res.data.workflow_runs.map((r) => ({
    id: r.id,
    name: r.name ?? "workflow",
    displayTitle: r.display_title ?? "",
    headBranch: r.head_branch ?? "",
    event: r.event,
    status: r.status ?? "queued",
    conclusion: r.conclusion,
    htmlUrl: r.html_url,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
  return runsForRequirement(runs, req).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

// Agent 中断/失败后重新触发开发：先摘掉再重打 agent:develop 标签
export async function retriggerDevelop(req: Requirement): Promise<void> {
  const gh = octokit();
  const { owner, repo: name } = parseRepo(req.repo);
  if (!req.githubIssueNumber) throw new Error("该需求尚未关联 GitHub Issue");
  await gh.issues
    .removeLabel({ owner, repo: name, issue_number: req.githubIssueNumber, name: AGENT_LABEL })
    .catch(() => {});
  await gh.issues.addLabels({
    owner,
    repo: name,
    issue_number: req.githubIssueNumber,
    labels: [AGENT_LABEL],
  });
}

// 门户内一键合并 PR：先校验所有 check 全绿，squash 合并并删除分支
export async function mergePullRequest(req: Requirement): Promise<string> {
  const gh = octokit();
  const { owner, repo: name } = parseRepo(req.repo);
  if (!req.prNumber) throw new Error("该需求尚未关联 PR");

  const pr = await gh.pulls.get({ owner, repo: name, pull_number: req.prNumber });
  if (pr.data.merged) return "PR 已是合并状态";
  if (pr.data.state !== "open") throw new Error("PR 已关闭，无法合并");

  const checks = await gh.checks.listForRef({ owner, repo: name, ref: pr.data.head.sha });
  const notGreen = checks.data.check_runs.filter(
    (c) =>
      c.status !== "completed" ||
      (c.conclusion !== null && !["success", "neutral", "skipped"].includes(c.conclusion))
  );
  if (notGreen.length > 0) {
    throw new Error(
      `CI 未全部通过，拒绝合并：${notGreen
        .map((c) => `${c.name}（${c.status === "completed" ? c.conclusion : "运行中"}）`)
        .join("、")}`
    );
  }

  await gh.pulls.merge({ owner, repo: name, pull_number: req.prNumber, merge_method: "squash" });
  if (req.branch) {
    await gh.git.deleteRef({ owner, repo: name, ref: `heads/${req.branch}` }).catch(() => {});
  }
  return `PR #${req.prNumber} 已合并（squash），分支已删除`;
}

// 轮询该需求关联 Issue 的 PR / 合并状态，用于门户端同步进度
export async function syncIssueState(req: Requirement): Promise<{
  prNumber: number | null;
  prUrl: string | null;
  merged: boolean;
  issueClosed: boolean;
}> {
  const gh = octokit();
  const { owner, repo: name } = parseRepo(req.repo);
  if (!req.githubIssueNumber) throw new Error("该需求尚未关联 GitHub Issue");

  const issue = await gh.issues.get({ owner, repo: name, issue_number: req.githubIssueNumber });

  // 通过时间线找到引用本 issue 的 PR
  const timeline = await gh.issues.listEventsForTimeline({
    owner,
    repo: name,
    issue_number: req.githubIssueNumber,
    per_page: 100,
  });
  let prNumber: number | null = req.prNumber;
  for (const ev of timeline.data) {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const src = (ev as any).source;
    if (ev.event === "cross-referenced" && src?.issue?.pull_request) {
      prNumber = src.issue.number;
    }
  }

  let prUrl: string | null = req.prUrl;
  let merged = false;
  if (prNumber) {
    const pr = await gh.pulls.get({ owner, repo: name, pull_number: prNumber });
    prUrl = pr.data.html_url;
    merged = pr.data.merged;
  }

  return { prNumber, prUrl, merged, issueClosed: issue.data.state === "closed" };
}
