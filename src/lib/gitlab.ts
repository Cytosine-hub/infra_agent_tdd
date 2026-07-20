import type { AgentRun, Requirement } from "./types";
import { testCasesToMarkdown } from "./testcase-gen";
import { branchNameFor } from "./workflow";
import { getRepoHost, getRepoToken } from "./db";
import { AGENT_LABEL } from "./github";

// 自建 GitLab（REST API v4）适配层：与 github.ts 暴露同名的高层函数，由 repo-provider 按 host 分派。
// 认证用仓库绑定的专用 token（一仓一 token）；host 可带 http:// 前缀（兼容内网 HTTP-only GitLab）。

interface GlCtx {
  base: string; // 形如 http://gitlab.x.cn/api/v4
  token: string;
}

function ctx(repoFullName: string): GlCtx {
  const host = getRepoHost(repoFullName);
  const origin = /^https?:\/\//.test(host) ? host.replace(/\/+$/, "") : `https://${host}`;
  const token = getRepoToken(repoFullName) || process.env.ZGL_TOKEN || "";
  if (!token) throw new Error(`GitLab 仓库 ${repoFullName} 未绑定访问令牌（在仓库管理中设置 token）`);
  return { base: `${origin}/api/v4`, token };
}

// 底层请求：pathAndQuery 已是完整路径（含数字 project id）。不做 %2F 编码——很多反代
// （Apache AllowEncodedSlashes off / nginx）会拦截路径里的编码斜杠，故一律用数字 project id。
async function apiFetch<T = unknown>(
  repoFullName: string,
  pathAndQuery: string,
  init?: { method?: string; body?: unknown }
): Promise<T> {
  const c = ctx(repoFullName);
  const res = await fetch(`${c.base}${pathAndQuery}`, {
    method: init?.method ?? "GET",
    headers: {
      "PRIVATE-TOKEN": c.token,
      ...(init?.body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`GitLab API ${init?.method ?? "GET"} ${pathAndQuery} -> ${res.status}: ${text.slice(0, 300)}`);
  }
  if (res.status === 204) return null as T;
  return (await res.json()) as T;
}

// full path → 数字 project id（缓存）。用 search 匹配 path_with_namespace，绕开被反代拦截的 %2F 路径查项目。
const projectIdCache = new Map<string, number>();
async function projectId(repoFullName: string): Promise<number> {
  const cached = projectIdCache.get(repoFullName);
  if (cached) return cached;
  const name = repoFullName.split("/").pop() ?? repoFullName;
  const list = await apiFetch<{ id: number; path_with_namespace: string }[]>(
    repoFullName,
    `/projects?search=${encodeURIComponent(name)}&membership=true&per_page=100`
  );
  const match = list.find((p) => p.path_with_namespace === repoFullName);
  if (!match) throw new Error(`在 GitLab 上找不到项目 ${repoFullName}（检查路径与令牌权限）`);
  projectIdCache.set(repoFullName, match.id);
  return match.id;
}

// project 级请求：自动解析数字 id 拼到 /projects/:id 前缀
async function gl<T = unknown>(
  repoFullName: string,
  projectSubPath: string,
  init?: { method?: string; body?: unknown }
): Promise<T> {
  const id = await projectId(repoFullName);
  return apiFetch<T>(repoFullName, `/projects/${id}${projectSubPath}`, init);
}

// —— 默认分支 ——
const defaultBranchCache = new Map<string, string>();
export async function getDefaultBranch(repoFullName: string): Promise<string> {
  const cached = defaultBranchCache.get(repoFullName);
  if (cached) return cached;
  try {
    const p = await gl<{ default_branch: string }>(repoFullName, "");
    const branch = p.default_branch || "main";
    defaultBranchCache.set(repoFullName, branch);
    return branch;
  } catch {
    return "main";
  }
}

// —— 建 Issue（含验收用例），并评论开发分支名 ——
export async function createIssueForRequirement(req: Requirement): Promise<{
  issueNumber: number;
  issueUrl: string;
  branch: string;
}> {
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
    "- 在独立分支上开发（分支名见下方评论），完成后向主分支提交 MR，MR 描述中引用本 Issue（`Closes #<本 issue 号>`）",
    "- 严格遵循本仓库根目录 agent.md 中的开发规范",
    "- 所有验收测试用例必须有对应的自动化测试并通过",
  ].join("\n");

  const issue = await gl<{ iid: number; web_url: string }>(req.repo, `/issues`, {
    method: "POST",
    body: {
      title: `[${req.team}] ${req.title}`,
      description: body,
      labels: [AGENT_LABEL, `team:${req.team}`, `priority:${req.priority}`].join(","),
    },
  });

  const branch = branchNameFor(req, issue.iid);
  await gl(req.repo, `/issues/${issue.iid}/notes`, {
    method: "POST",
    body: { body: `开发分支：\`${branch}\`` },
  }).catch(() => {});

  return { issueNumber: issue.iid, issueUrl: issue.web_url, branch };
}

// —— 建（或复用）MR ——
export async function createOrGetPullRequest(
  req: Requirement,
  opts: { branch: string; base: string; title: string; body: string }
): Promise<{ number: number; url: string }> {
  const existing = await gl<{ iid: number; web_url: string }[]>(
    req.repo,
    `/merge_requests?source_branch=${encodeURIComponent(opts.branch)}&state=opened`
  );
  if (existing.length > 0) return { number: existing[0].iid, url: existing[0].web_url };

  const mr = await gl<{ iid: number; web_url: string }>(req.repo, `/merge_requests`, {
    method: "POST",
    body: {
      source_branch: opts.branch,
      target_branch: opts.base,
      title: opts.title,
      description: opts.body,
      remove_source_branch: true,
    },
  });
  return { number: mr.iid, url: mr.web_url };
}

// —— MR 评论 ——
export async function postPrComment(req: Requirement, body: string): Promise<void> {
  if (!req.prNumber) throw new Error("该需求尚未关联 MR");
  await gl(req.repo, `/merge_requests/${req.prNumber}/notes`, {
    method: "POST",
    body: { body },
  });
}

// —— 入驻：新分支写入文件 + 开 MR ——
export async function openDocsPr(
  repoFullName: string,
  files: { path: string; text: string }[],
  meta: { branch: string; title: string; body: string }
): Promise<string> {
  const base = await getDefaultBranch(repoFullName);

  // 建分支（不存在则从 base 新建；已存在则复用，后续 commit 覆盖文件）。
  // 分支名含斜杠，而本环境反代拦截路径中的 %2F，故不用「按名删分支」，一律走请求体传分支名。
  await gl(repoFullName, `/repository/branches`, {
    method: "POST",
    body: { branch: meta.branch, ref: base },
  }).catch(() => {
    /* 已存在则复用 */
  });

  // 逐文件判断 create/update，单次提交多文件
  const actions: { action: "create" | "update"; file_path: string; content: string }[] = [];
  for (const f of files) {
    let exists = true;
    await gl(
      repoFullName,
      `/repository/files/${encodeURIComponent(f.path)}?ref=${encodeURIComponent(meta.branch)}`
    ).catch(() => {
      exists = false;
    });
    actions.push({ action: exists ? "update" : "create", file_path: f.path, content: f.text });
  }
  await gl(repoFullName, `/repository/commits`, {
    method: "POST",
    body: { branch: meta.branch, commit_message: "docs: 入驻自动生成/更新 agent.md 及引导文件", actions },
  });

  const existing = await gl<{ iid: number; web_url: string }[]>(
    repoFullName,
    `/merge_requests?source_branch=${encodeURIComponent(meta.branch)}&state=opened`
  );
  if (existing.length > 0) return existing[0].web_url;
  const mr = await gl<{ web_url: string }>(repoFullName, `/merge_requests`, {
    method: "POST",
    body: { source_branch: meta.branch, target_branch: base, title: meta.title, description: meta.body },
  });
  return mr.web_url;
}

// —— 流水线运行状态（对应 GitHub Actions runs）——
interface GlPipeline {
  id: number;
  status: string;
  ref: string;
  source: string;
  web_url: string;
  created_at: string;
  updated_at: string;
}
export async function listAgentRuns(req: Requirement): Promise<AgentRun[]> {
  const ref = req.branch;
  if (!ref) return [];
  const pipelines = await gl<GlPipeline[]>(
    req.repo,
    `/pipelines?ref=${encodeURIComponent(ref)}&per_page=30`
  ).catch(() => [] as GlPipeline[]);
  return pipelines
    .map((p) => {
      const done = ["success", "failed", "canceled", "skipped", "manual"].includes(p.status);
      const conclusion =
        p.status === "success"
          ? "success"
          : p.status === "failed"
            ? "failure"
            : p.status === "canceled"
              ? "cancelled"
              : done
                ? p.status
                : null;
      return {
        id: p.id,
        name: `Pipeline #${p.id}`,
        displayTitle: `${p.source} @ ${p.ref}`,
        headBranch: p.ref,
        event: p.source,
        status: done ? "completed" : p.status === "running" ? "in_progress" : "queued",
        conclusion,
        htmlUrl: p.web_url,
        createdAt: p.created_at,
        updatedAt: p.updated_at,
      } as AgentRun;
    })
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

// —— 合并 MR（先校验流水线通过）——
interface GlMr {
  iid: number;
  state: string;
  merge_status?: string;
  head_pipeline?: { status: string } | null;
  pipeline?: { status: string } | null;
}
export async function mergePullRequest(req: Requirement): Promise<string> {
  if (!req.prNumber) throw new Error("该需求尚未关联 MR");
  const mr = await gl<GlMr>(req.repo, `/merge_requests/${req.prNumber}`);
  if (mr.state === "merged") return "MR 已是合并状态";
  if (mr.state !== "opened") throw new Error("MR 已关闭，无法合并");

  const pipeStatus = mr.head_pipeline?.status ?? mr.pipeline?.status ?? "";
  if (pipeStatus && !["success", "skipped", "manual"].includes(pipeStatus)) {
    throw new Error(`流水线未通过，拒绝合并：当前状态 ${pipeStatus}`);
  }

  await gl(req.repo, `/merge_requests/${req.prNumber}/merge`, {
    method: "PUT",
    body: { squash: true, should_remove_source_branch: true },
  });
  return `MR !${req.prNumber} 已合并（squash），分支已删除`;
}

// —— 废弃：关 MR、删分支、评论并关 Issue ——
export async function abandonOnGithub(req: Requirement, reason: string): Promise<void> {
  if (!req.githubIssueNumber) return;
  if (req.prNumber) {
    await gl(req.repo, `/merge_requests/${req.prNumber}`, {
      method: "PUT",
      body: { state_event: "close" },
    }).catch(() => {});
  }
  if (req.branch) {
    await gl(
      req.repo,
      `/repository/branches/${encodeURIComponent(req.branch)}`,
      { method: "DELETE" }
    ).catch(() => {});
  }
  await gl(req.repo, `/issues/${req.githubIssueNumber}/notes`, {
    method: "POST",
    body: { body: `需求已在门户废弃：${reason}\n\n如需继续，请拆解为更小的需求后重新提交。` },
  }).catch(() => {});
  await gl(req.repo, `/issues/${req.githubIssueNumber}`, {
    method: "PUT",
    body: { state_event: "close" },
  }).catch(() => {});
}

// —— 同步 Issue/MR 状态 ——
export async function syncIssueState(req: Requirement): Promise<{
  prNumber: number | null;
  prUrl: string | null;
  merged: boolean;
  issueClosed: boolean;
}> {
  if (!req.githubIssueNumber) throw new Error("该需求尚未关联 GitLab Issue");
  const issue = await gl<{ state: string }>(req.repo, `/issues/${req.githubIssueNumber}`);

  // 找与该 Issue 关联的 MR
  const related = await gl<GlMr[]>(
    req.repo,
    `/issues/${req.githubIssueNumber}/related_merge_requests`
  ).catch(() => [] as GlMr[]);

  let prNumber: number | null = req.prNumber;
  let prUrl: string | null = req.prUrl;
  let merged = false;
  const mrList = related.length
    ? related
    : await gl<(GlMr & { web_url: string })[]>(
        req.repo,
        `/merge_requests?source_branch=${encodeURIComponent(req.branch ?? "")}&state=all`
      ).catch(() => [] as (GlMr & { web_url: string })[]);
  const picked = (mrList as (GlMr & { web_url?: string })[])[0];
  if (picked) {
    prNumber = picked.iid;
    if (picked.web_url) prUrl = picked.web_url;
    merged = picked.state === "merged";
  }

  return { prNumber, prUrl, merged, issueClosed: issue.state === "closed" };
}
