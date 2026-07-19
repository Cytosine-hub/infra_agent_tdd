import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import fs from "node:fs";
import { Octokit } from "@octokit/rest";
import {
  addEvent,
  createAgentTask,
  getAgentTask,
  getRequirement,
  latestAgentTask,
  updateAgentTask,
  updateRequirement,
  type AgentTaskRow,
} from "./db";
import type { Requirement } from "./types";
import { testCasesToMarkdown } from "./testcase-gen";

const execFileP = promisify(execFile);

// 本地 Agent 执行器：调用本机已登录的 Claude Code / Codex CLI 完成开发。
// 不走 Anthropic API 计费，复用客户端订阅额度；门户服务器需装有对应 CLI。
//
// 流程：clone(独立工作区) → 建分支 → 生成任务提示词 → 本地 CLI 开发(测试先行)
//     → runner 强制跑仓库测试 → 兜底提交 → push → Octokit 建 PR → 需求转入 in_review

export const ENGINES: Record<string, { cmd: string; args: (promptFile: string) => string[] }> = {
  claude: {
    cmd: "claude",
    // -p 无头模式；权限跳过仅作用于隔离工作区
    args: (promptFile) => ["-p", fs.readFileSync(promptFile, "utf-8"), "--dangerously-skip-permissions"],
  },
  codex: {
    cmd: "codex",
    args: (promptFile) => ["exec", "--full-auto", fs.readFileSync(promptFile, "utf-8")],
  },
};

export async function availableEngines(): Promise<string[]> {
  const found: string[] = [];
  for (const [name, e] of Object.entries(ENGINES)) {
    try {
      await execFileP("which", [e.cmd]);
      found.push(name);
    } catch {
      /* not installed */
    }
  }
  return found;
}

const DATA_DIR = process.env.DATA_DIR ?? path.join(process.cwd(), "data");
const TIMEOUT_MS = Number(process.env.AGENT_TIMEOUT_MIN ?? 30) * 60_000;

function cloneUrl(repo: string): string {
  const token = process.env.GITHUB_TOKEN;
  return token
    ? `https://x-access-token:${token}@github.com/${repo}.git`
    : `git@github.com:${repo}.git`;
}

function buildPrompt(req: Requirement): string {
  return [
    `你是自动化开发 Agent，请在当前仓库工作区内完成以下需求的开发。`,
    ``,
    `# 需求（门户需求 #${req.id} · GitHub Issue #${req.githubIssueNumber}）`,
    ``,
    `标题：${req.title}`,
    ``,
    `## 需求描述`,
    req.description,
    ``,
    `## 验收测试用例（必须全部满足）`,
    testCasesToMarkdown(req.testCases ?? []),
    ``,
    `# 工作要求`,
    `1. 先完整阅读仓库根目录 agent.md 并严格遵循其中的开发规范。`,
    `2. 当前已处于开发分支 ${req.branch}，不要切换分支、不要推送、不要创建 PR（由平台完成）。`,
    `3. 测试先行：先把每条验收测试用例转成自动化测试（测试名注明用例编号，如 TC-01），再实现功能。`,
    `4. 运行仓库完整测试套件，确保全部通过且无回归。`,
    `5. 完成后用中文提交（git commit），提交信息格式遵循 agent.md，引用 Issue 编号 #${req.githubIssueNumber}。`,
  ].join("\n");
}

// 入队并异步启动（不阻塞 API 请求）
export function enqueueDevTask(requirementId: number, engine: string): AgentTaskRow {
  const last = latestAgentTask(requirementId);
  if (last && (last.status === "queued" || last.status === "running") && pidAlive(last.pid)) {
    throw new Error(`该需求已有进行中的 Agent 任务（#${last.id}），请等待其结束`);
  }
  const task = createAgentTask(requirementId, engine);
  void runTask(task.id).catch((err) => {
    updateAgentTask(task.id, { status: "failed", error: String(err) });
  });
  return task;
}

export function pidAlive(pid: number | null): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function sh(cwd: string, log: number, cmd: string, args: string[], env?: NodeJS.ProcessEnv) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", log, log] });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} ${args[0] ?? ""} 退出码 ${code}`))
    );
  });
}

async function runTask(taskId: number) {
  const task = getAgentTask(taskId);
  if (!task) throw new Error("任务不存在");
  const req = getRequirement(task.requirementId);
  if (!req) throw new Error("需求不存在");
  if (!req.branch || !req.githubIssueNumber) throw new Error("需求缺少分支/Issue 信息");
  const branch = req.branch;

  const wsRoot = path.join(DATA_DIR, "workspaces");
  const workspace = path.join(wsRoot, `req-${req.id}-task-${task.id}`);
  const logDir = path.join(DATA_DIR, "agent-logs");
  fs.mkdirSync(wsRoot, { recursive: true });
  fs.mkdirSync(logDir, { recursive: true });
  const logPath = path.join(logDir, `task-${task.id}.log`);
  const log = fs.openSync(logPath, "a");
  const logLine = (s: string) => fs.writeSync(log, `\n===== [portal] ${s} =====\n`);

  updateAgentTask(task.id, { status: "running", logPath, workspace, step: "clone" });
  addEvent(req.id, "agent_task_started", "system", `本地 Agent 任务 #${task.id}（${task.engine}）启动`);

  try {
    // 1. 独立工作区 clone + 分支
    logLine(`clone ${req.repo}`);
    fs.rmSync(workspace, { recursive: true, force: true });
    await sh(wsRoot, log, "git", ["clone", "--depth", "20", cloneUrl(req.repo), workspace]);
    logLine(`checkout ${req.branch}`);
    // 分支可能已存在（重试场景）：优先复用远程分支
    await sh(workspace, log, "git", ["checkout", "-B", branch]).catch(async () => {
      await sh(workspace, log, "git", ["checkout", branch]);
    });

    // 2. 本地 CLI 开发
    const engine = ENGINES[task.engine];
    if (!engine) throw new Error(`未知引擎：${task.engine}`);
    const promptFile = path.join(workspace, ".agent-prompt.md");
    fs.writeFileSync(promptFile, buildPrompt(req));
    updateAgentTask(task.id, { step: "develop" });
    logLine(`run ${task.engine}`);
    await new Promise<void>((resolve, reject) => {
      const child = spawn(engine.cmd, engine.args(promptFile), {
        cwd: workspace,
        env: { ...process.env, GH_TOKEN: process.env.GITHUB_TOKEN },
        stdio: ["ignore", log, log],
        detached: false,
      });
      updateAgentTask(task.id, { pid: child.pid ?? null });
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`Agent 执行超时（${TIMEOUT_MS / 60000} 分钟）`));
      }, TIMEOUT_MS);
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        code === 0 ? resolve() : reject(new Error(`${task.engine} 退出码 ${code}`));
      });
    });
    fs.rmSync(promptFile, { force: true });

    // 3. runner 强制校验测试（不信任 agent 的自述）
    updateAgentTask(task.id, { step: "verify" });
    logLine("verify: npm install && npm test");
    if (fs.existsSync(path.join(workspace, "package.json"))) {
      await sh(workspace, log, "npm", ["install", "--no-audit", "--no-fund"]);
      await sh(workspace, log, "npm", ["test", "--if-present"]);
    }

    // 4. 兜底提交未提交的变更
    logLine("commit fallback");
    await sh(workspace, log, "git", ["add", "-A"]);
    await sh(workspace, log, "git", [
      "-c", "user.name=portal-agent",
      "-c", "user.email=portal-agent@local",
      "commit", "-m", `feat: ${req.title} (#${req.githubIssueNumber})`,
    ]).catch(() => {/* 无未提交变更时忽略 */});

    // 确认相对 main 有实际提交
    await sh(workspace, log, "git", ["fetch", "origin", "main"]);
    const { stdout } = await execFileP("git", ["rev-list", "--count", "origin/main..HEAD"], {
      cwd: workspace,
    });
    if (Number(stdout.trim()) === 0) throw new Error("Agent 未产生任何提交");

    // 5. push + 建 PR
    updateAgentTask(task.id, { step: "push" });
    logLine(`push ${req.branch}`);
    await sh(workspace, log, "git", ["push", "-u", "origin", branch, "--force-with-lease"]);

    updateAgentTask(task.id, { step: "pull_request" });
    const [owner, name] = req.repo.split("/");
    const gh = new Octokit({ auth: process.env.GITHUB_TOKEN });
    const existing = await gh.pulls.list({ owner, repo: name, head: `${owner}:${branch}`, state: "open" });
    let prNumber: number, prUrl: string;
    if (existing.data.length > 0) {
      prNumber = existing.data[0].number;
      prUrl = existing.data[0].html_url;
    } else {
      const pr = await gh.pulls.create({
        owner,
        repo: name,
        base: "main",
        head: branch,
        title: `[${req.team}] ${req.title}`,
        body: [
          `由本地 Agent（${task.engine}）自动开发。`,
          "",
          `- 门户需求：#${req.id}`,
          `- 验收测试用例：见 Issue，已全部转为自动化测试并在本地通过`,
          "",
          `Closes #${req.githubIssueNumber}`,
        ].join("\n"),
      });
      prNumber = pr.data.number;
      prUrl = pr.data.html_url;
    }

    updateRequirement(req.id, { status: "in_review", prNumber, prUrl });
    updateAgentTask(task.id, { status: "succeeded", step: "done", pid: null });
    addEvent(req.id, "agent_task_succeeded", "system", `Agent 任务 #${task.id} 完成，已创建 PR #${prNumber}`);
    logLine(`done: PR #${prNumber}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    updateAgentTask(task.id, { status: "failed", error: message, pid: null });
    addEvent(req.id, "agent_task_failed", "system", `Agent 任务 #${task.id} 失败：${message}`);
    logLine(`FAILED: ${message}`);
  } finally {
    fs.closeSync(log);
  }
}

export function readLogTail(logPath: string, maxBytes = 8000): string {
  try {
    const stat = fs.statSync(logPath);
    const fd = fs.openSync(logPath, "r");
    const start = Math.max(0, stat.size - maxBytes);
    const buf = Buffer.alloc(stat.size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    return buf.toString("utf-8");
  } catch {
    return "";
  }
}
