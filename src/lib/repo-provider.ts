import type { AgentRun, Requirement } from "./types";
import { getRepoProvider, getRepoToken } from "./db";
import * as gh from "./github";
import * as gl from "./gitlab";

// 代码托管提供方分派：按仓库的 provider（github / 自建 gitlab）选择对应 API 适配层。
// 上层（actions 路由、agent-runner、onboard）只依赖本 façade，不直接耦合具体托管平台。

// 两个适配层共同实现的高层接口（github.ts / gitlab.ts 均导出同名同签名函数）
interface RepoProviderImpl {
  getDefaultBranch(repoFullName: string): Promise<string>;
  createIssueForRequirement(
    req: Requirement
  ): Promise<{ issueNumber: number; issueUrl: string; branch: string }>;
  createOrGetPullRequest(
    req: Requirement,
    opts: { branch: string; base: string; title: string; body: string }
  ): Promise<{ number: number; url: string }>;
  postPrComment(req: Requirement, body: string): Promise<void>;
  openDocsPr(
    repoFullName: string,
    files: { path: string; text: string }[],
    meta: { branch: string; title: string; body: string }
  ): Promise<string>;
  listAgentRuns(req: Requirement): Promise<AgentRun[]>;
  mergePullRequest(req: Requirement): Promise<string>;
  abandonOnGithub(req: Requirement, reason: string): Promise<void>;
  syncIssueState(
    req: Requirement
  ): Promise<{ prNumber: number | null; prUrl: string | null; merged: boolean; issueClosed: boolean }>;
}

const githubImpl: RepoProviderImpl = gh;
const gitlabImpl: RepoProviderImpl = gl;

function impl(repoFullName: string): RepoProviderImpl {
  return getRepoProvider(repoFullName) === "gitlab" ? gitlabImpl : githubImpl;
}

export const AGENT_LABEL = gh.AGENT_LABEL;

// 该仓库的托管平台是否已具备可用凭据：GitHub 看全局 GITHUB_TOKEN；GitLab 看仓库专用 token（或 ZGL_TOKEN 兜底）。
export function providerConfigured(repoFullName: string): boolean {
  if (getRepoProvider(repoFullName) === "gitlab") {
    return Boolean(getRepoToken(repoFullName) || process.env.ZGL_TOKEN);
  }
  return Boolean(process.env.GITHUB_TOKEN);
}

// 兼容旧调用（无仓库上下文时的全局 GitHub 判断）
export function githubConfigured(): boolean {
  return gh.githubConfigured();
}

export function getDefaultBranch(repoFullName: string): Promise<string> {
  return impl(repoFullName).getDefaultBranch(repoFullName);
}

export function createIssueForRequirement(
  req: Requirement
): Promise<{ issueNumber: number; issueUrl: string; branch: string }> {
  return impl(req.repo).createIssueForRequirement(req);
}

export function createOrGetPullRequest(
  req: Requirement,
  opts: { branch: string; base: string; title: string; body: string }
): Promise<{ number: number; url: string }> {
  return impl(req.repo).createOrGetPullRequest(req, opts);
}

export function postPrComment(req: Requirement, body: string): Promise<void> {
  return impl(req.repo).postPrComment(req, body);
}

export function openDocsPr(
  repoFullName: string,
  files: { path: string; text: string }[],
  meta: { branch: string; title: string; body: string }
): Promise<string> {
  return impl(repoFullName).openDocsPr(repoFullName, files, meta);
}

export function listAgentRuns(req: Requirement): Promise<AgentRun[]> {
  return impl(req.repo).listAgentRuns(req);
}

export function mergePullRequest(req: Requirement): Promise<string> {
  return impl(req.repo).mergePullRequest(req);
}

export function abandonOnGithub(req: Requirement, reason: string): Promise<void> {
  return impl(req.repo).abandonOnGithub(req, reason);
}

export function syncIssueState(req: Requirement): Promise<{
  prNumber: number | null;
  prUrl: string | null;
  merged: boolean;
  issueClosed: boolean;
}> {
  return impl(req.repo).syncIssueState(req);
}
