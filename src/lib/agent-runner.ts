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
import type { Requirement, TestCase } from "./types";
import { generateWithEngine, generateWithTemplate, testCasesToMarkdown } from "./testcase-gen";
import { ensureGuardApproved } from "./guard";
import { getDefaultBranch } from "./github";
import { DATA_DIR, prepareRepoWorkspace, repoWorkspaceDir } from "./repo-index";

const execFileP = promisify(execFile);

// 本地 Agent 执行器：调用本机已登录的 Claude Code / Codex CLI 完成开发。
// 不走 Anthropic API 计费，复用客户端订阅额度；门户服务器需装有对应 CLI。
//
// 流程：clone(独立工作区) → 建分支 → 生成任务提示词 → 本地 CLI 开发(测试先行)
//     → runner 强制跑仓库测试 → 兜底提交 → push → Octokit 建 PR → 需求转入 in_review

export type Effort = "low" | "medium" | "high";

export interface ExecOptions {
  model?: string;
  effort?: Effort;
}

interface EngineDef {
  cmd: string;
  models: string[]; // 第一个为默认
  args: (prompt: string, opts: ExecOptions) => string[];
  env: (opts: ExecOptions) => Record<string, string>;
}

// 模型清单可用环境变量覆盖（逗号分隔，第一个为默认），适配各家账号/网关开通的型号：
//   AGENT_MODELS_CLAUDE=claude-sonnet-5,claude-opus-4-8
//   AGENT_MODELS_CODEX=gpt-5.5,gpt-5.2-codex
function modelsFromEnv(envKey: string, defaults: string[]): string[] {
  const v = (process.env[envKey] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return v.length > 0 ? v : defaults;
}

export const ENGINES: Record<string, EngineDef> = {
  claude: {
    cmd: "claude",
    models: modelsFromEnv("AGENT_MODELS_CLAUDE", [
      "claude-sonnet-5",
      "claude-opus-4-8",
      "claude-haiku-4-5-20251001",
    ]),
    // -p 无头模式；权限跳过仅作用于隔离工作区
    args: (prompt, opts) => [
      "-p",
      prompt,
      "--dangerously-skip-permissions",
      ...(opts.model ? ["--model", opts.model] : []),
    ],
    // Claude Code 的推理强度用思考 token 预算控制
    env: (opts) => {
      const env: Record<string, string> = {};
      if (opts.effort === "high") env.MAX_THINKING_TOKENS = "31999";
      else if (opts.effort === "medium") env.MAX_THINKING_TOKENS = "16000";
      return env;
    },
  },
  codex: {
    cmd: "codex",
    models: modelsFromEnv("AGENT_MODELS_CODEX", ["gpt-5.5", "gpt-5.2-codex", "gpt-5.2"]),
    args: (prompt, opts) => [
      "exec",
      "--full-auto",
      ...(opts.model ? ["-m", opts.model] : []),
      ...(opts.effort ? ["-c", `model_reasoning_effort="${opts.effort}"`] : []),
      prompt,
    ],
    env: () => ({}),
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

const TIMEOUT_MS = Number(process.env.AGENT_TIMEOUT_MIN ?? 30) * 60_000;
const MAX_FIX_ROUNDS = Number(process.env.AGENT_MAX_FIX_ROUNDS ?? 3);
const AUTO_FIX = process.env.AGENT_AUTO_FIX !== "0";

// 解析审查结论：首个有意义行含"建议合并"→approved；含"建议修改"→changes
export function parseReviewVerdict(result: string): "approved" | "changes" | "" {
  const head = (result || "").split(/\r?\n/).find((l) => l.trim())?.trim() ?? "";
  const scope = head || result;
  if (/建议修改|需要修改|不建议合并/.test(scope)) return "changes";
  if (/建议合并|通过|可以合并|approve/i.test(scope)) return "approved";
  // 兜底：全文里找
  if (/建议修改|需要修改/.test(result)) return "changes";
  if (/建议合并/.test(result)) return "approved";
  return "";
}

// codegraph 代码智能：为 agent 提示引导使用（索引复用逻辑见 repo-index.ts）
function codegraphHint(indexed: boolean): string {
  if (!indexed) return "";
  return [
    ``,
    `# 代码智能工具 codegraph（已为本仓库建好索引，强烈建议使用）`,
    `动手前先用它理解代码结构与影响面，不要盲目全库 grep：`,
    `- \`codegraph explore <关键词...>\`：一次拿到相关符号的源码 + 调用链`,
    `- \`codegraph node <符号名>\`：某符号的源码 + 谁调用它 / 它调用谁`,
    `- \`codegraph callers <符号>\` / \`codegraph callees <符号>\`：调用方 / 被调方`,
    `- \`codegraph impact <符号>\`：改动该符号会波及哪些代码——**修改已有符号前务必查一次影响面**`,
  ].join("\n");
}

function buildPrompt(req: Requirement, codegraph = "", fixFeedback = ""): string {
  const fixMode = !!fixFeedback;
  return [
    fixMode
      ? `你是自动化开发 Agent。当前分支上已有实现，但代码审查提出了修改意见，请针对意见修改现有代码。`
      : `你是自动化开发 Agent，请在当前仓库工作区内完成以下需求的开发。`,
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
    fixMode ? `## ⚠️ 上一轮代码审查意见（请逐条修改解决）\n${fixFeedback}` : ``,
    ``,
    `# 工作要求`,
    `1. 先完整阅读仓库根目录 agent.md 并严格遵循其中的开发规范。`,
    fixMode
      ? `2. 当前分支 ${req.branch} 已检出既有实现，请在其基础上**针对上述审查意见逐条修改**，不要推倒重来、不要切换分支、不要推送/建 PR（由平台完成）。`
      : `2. 当前已处于开发分支 ${req.branch}，不要切换分支、不要推送、不要创建 PR（由平台完成）。`,
    `3. 测试先行：先把每条验收测试用例转成自动化测试（测试名注明用例编号，如 TC-01），再实现功能。`,
    `4. 运行仓库完整测试套件，确保全部通过且无回归。`,
    `5. 完成后用中文提交（git commit），提交信息格式遵循 agent.md，引用 Issue 编号 #${req.githubIssueNumber}。`,
    codegraph,
  ].join("\n");
}

// 任务只入队，执行由独立的 runner 守护进程（npm run runner）认领。
// 门户重启不再中断任务；runner 重启会把孤儿任务标记失败，可一键重触发。
function assertNoActiveTask(requirementId: number, kind: "develop" | "review" | "testcases") {
  const last = latestAgentTask(requirementId, kind);
  if (
    last &&
    // running 且（无子进程 pid，即 runner 进程内跑，如用例生成 / 子进程仍存活）→ 视为活跃。
    // 崩溃残留的 running 任务由 runner 启动时 failStaleRunningTasks(pidAlive) 清理。
    (last.status === "queued" ||
      (last.status === "running" && (last.pid == null || pidAlive(last.pid))))
  ) {
    throw new Error(`该需求已有排队/进行中的${kind === "develop" ? "开发" : kind === "review" ? "审查" : "用例生成"}任务（#${last.id}）`);
  }
}

export function enqueueDevTask(
  requirementId: number,
  engine: string,
  opts: ExecOptions = {}
): AgentTaskRow {
  assertNoActiveTask(requirementId, "develop");
  return createAgentTask(requirementId, engine, opts.model ?? "", opts.effort ?? "");
}

// PR 审查任务入队：默认 codex（可用 AGENT_REVIEW_ENGINE 覆盖），与开发引擎交叉互审
export function enqueueReviewTask(requirementId: number, engine?: string): AgentTaskRow {
  const reviewEngine = engine ?? process.env.AGENT_REVIEW_ENGINE ?? "codex";
  if (!ENGINES[reviewEngine]) throw new Error(`不支持的审查引擎：${reviewEngine}`);
  assertNoActiveTask(requirementId, "review");
  return createAgentTask(requirementId, reviewEngine, "", "", "review");
}

// 测试用例生成任务入队：默认 codex（TESTCASE_ENGINE 覆盖）
export function enqueueTestcaseTask(requirementId: number, engine?: string): AgentTaskRow {
  const genEngine = engine ?? process.env.TESTCASE_ENGINE ?? "codex";
  if (!ENGINES[genEngine]) throw new Error(`不支持的用例生成引擎：${genEngine}`);
  assertNoActiveTask(requirementId, "testcases");
  return createAgentTask(requirementId, genEngine, "", "", "testcases");
}

// runner 守护进程的任务分发入口
export async function executeTask(taskId: number): Promise<void> {
  const task = getAgentTask(taskId);
  if (!task) throw new Error(`任务 #${taskId} 不存在`);
  try {
    if (task.kind === "develop") await runTask(taskId);
    else if (task.kind === "review") await runReviewTask(taskId);
    else await runTestcaseTask(taskId);
  } catch (err) {
    updateAgentTask(taskId, { status: "failed", error: String(err), pid: null });
  }
}

// 任务的“有效状态”：running 但（子进程已死 或 执行器离线）→ 判为中断失败。
// 覆盖两类情况：有子进程 pid 的开发/审查任务崩溃；runner 进程内跑的用例生成任务在 runner 宕机时。
export function effectiveTaskStatus(
  task: { status: string; pid: number | null },
  runnerOnline: boolean
): { status: string; interrupted: boolean } {
  if (task.status !== "running") return { status: task.status, interrupted: false };
  const subprocDead = task.pid != null && !pidAlive(task.pid);
  if (subprocDead || !runnerOnline) return { status: "failed", interrupted: true };
  return { status: "running", interrupted: false };
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

  const logDir = path.join(DATA_DIR, "agent-logs");
  fs.mkdirSync(logDir, { recursive: true });
  const logPath = path.join(logDir, `task-${task.id}.log`);
  const log = fs.openSync(logPath, "a");
  const logLine = (s: string) => fs.writeSync(log, `\n===== [portal] ${s} =====\n`);

  const workspace = repoWorkspaceDir(req.repo);
  updateAgentTask(task.id, { status: "running", logPath, workspace, step: "guard" });
  addEvent(req.id, "agent_task_started", "system", `本地 Agent 任务 #${task.id}（${task.engine}）启动`);

  try {
    await ensureGuardApproved(req.id); // 防滥用门审

    // 修复迭代模式：已有 PR + 审查意见 → 在既有分支上改，而非从 main 重做
    const fixFeedback = req.prNumber && req.reviewVerdict === "changes" ? req.reviewFeedback : "";
    const isFix = !!fixFeedback;
    const baseBranch = await getDefaultBranch(req.repo);

    // 1. 共享工作区（同项目串行复用，非每任务重 clone）：清理 → 切分支 → 增量索引
    updateAgentTask(task.id, { step: "clone" });
    logLine(`prepare workspace ${req.repo} @ ${branch}${isFix ? "（修复迭代，复用既有分支）" : ""}`);
    const { indexed } = await prepareRepoWorkspace(req.repo, {
      branch,
      base: isFix ? undefined : baseBranch,
      useExistingBranch: isFix,
    });
    // 修复迭代的提交对比基准：既有分支 tip（切分支前 = origin/<branch>）
    const fixBaseSha = isFix
      ? (await execFileP("git", ["rev-parse", `origin/${branch}`], { cwd: workspace })).stdout.trim()
      : "";
    const cgHint = codegraphHint(indexed);

    // 2. 本地 CLI 开发
    const engine = ENGINES[task.engine];
    if (!engine) throw new Error(`未知引擎：${task.engine}`);
    const opts: ExecOptions = {
      model: task.model || undefined,
      effort: (task.effort || undefined) as Effort | undefined,
    };
    updateAgentTask(task.id, { step: isFix ? "fix" : "develop" });
    logLine(`run ${task.engine}${isFix ? " [修复迭代]" : ""} (model=${task.model || "默认"}, effort=${task.effort || "默认"})`);
    await new Promise<void>((resolve, reject) => {
      const child = spawn(engine.cmd, engine.args(buildPrompt(req, cgHint, fixFeedback), opts), {
        cwd: workspace,
        env: { ...process.env, GH_TOKEN: process.env.GITHUB_TOKEN, ...engine.env(opts) },
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

    // 确认有实际新提交。基准：初次开发对比默认分支；修复迭代对比既有分支 tip
    const commitBase = isFix ? fixBaseSha : `origin/${baseBranch}`;
    const { stdout } = await execFileP("git", ["rev-list", "--count", `${commitBase}..HEAD`], {
      cwd: workspace,
    });
    if (Number(stdout.trim()) === 0) {
      throw new Error(isFix ? "修复迭代未产生新提交（未按审查意见修改）" : "Agent 未产生任何提交");
    }

    // 5. push + 建 PR。修复迭代是既有分支上的快进 → 普通 push；初次开发分支被重置 → 回退到 force。
    updateAgentTask(task.id, { step: "push" });
    logLine(`push ${req.branch}`);
    await sh(workspace, log, "git", ["push", "-u", "origin", branch]).catch(async () => {
      logLine("普通 push 失败（分支历史被重置），改用 --force-with-lease");
      await sh(workspace, log, "git", ["push", "-u", "origin", branch, "--force-with-lease"]);
    });

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
        base: baseBranch,
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

    // 开发完成后自动触发 PR 审查（默认 codex；AGENT_AUTO_REVIEW=0 关闭）
    if (process.env.AGENT_AUTO_REVIEW !== "0") {
      try {
        enqueueReviewTask(req.id);
      } catch (e) {
        console.error("自动触发审查失败:", e);
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    updateAgentTask(task.id, { status: "failed", error: message, pid: null });
    addEvent(req.id, "agent_task_failed", "system", `Agent 任务 #${task.id} 失败：${message}`);
    logLine(`FAILED: ${message}`);
  } finally {
    fs.closeSync(log);
  }
}

// 测试用例生成任务：优先用任务指定引擎（默认 codex），失败退回本地模板
async function runTestcaseTask(taskId: number) {
  const task = getAgentTask(taskId);
  if (!task) throw new Error("任务不存在");
  const req = getRequirement(task.requirementId);
  if (!req) throw new Error("需求不存在");

  updateAgentTask(task.id, { status: "running", step: "guard" });
  await ensureGuardApproved(req.id); // 防滥用门审：非开发需求/白名单外仓库直接终止

  updateAgentTask(task.id, { step: "generate" });
  addEvent(req.id, "testcase_task_started", "system", `用例生成任务 #${task.id}（${task.engine}）启动`);

  let cases: TestCase[];
  let source = task.engine;
  try {
    cases = await generateWithEngine(req, task.engine);
  } catch (err) {
    console.error("引擎生成用例失败，回退模板:", err);
    cases = generateWithTemplate(req);
    source = "template";
  }

  updateRequirement(req.id, {
    status: "testcases_generated",
    testCases: cases,
    leadApprovedTests: 0,
    requesterApprovedTests: 0,
  });
  updateAgentTask(task.id, {
    status: "succeeded",
    step: "done",
    result: `生成 ${cases.length} 条用例（来源：${source}）`,
  });
  addEvent(
    req.id,
    "tests_generated",
    "system",
    source === "template"
      ? `本地模板生成 ${cases.length} 条用例（${task.engine} 生成失败的兜底）`
      : `本地 ${source} 生成 ${cases.length} 条测试用例`
  );
}

function buildReviewPrompt(req: Requirement, baseBranch: string): string {
  return [
    `你是代码审查员。当前工作区已检出 PR 分支（${req.branch}），请审查该 PR 的变更。`,
    ``,
    `# 需求背景（GitHub Issue #${req.githubIssueNumber}）`,
    `标题：${req.title}`,
    `需求描述：${req.description}`,
    ``,
    `## 验收测试用例`,
    testCasesToMarkdown(req.testCases ?? []),
    ``,
    `# 审查步骤`,
    `1. 运行 \`git diff origin/${baseBranch}...HEAD\` 查看全部变更。`,
    `2. 阅读仓库根目录 agent.md，核对变更是否符合开发规范（模块自包含、不改他人文件等）。`,
    `3. 核对每条验收测试用例是否有对应的自动化测试且断言正确。`,
    `4. 检查明显缺陷、安全问题、对现有功能的破坏。`,
    ``,
    `# 输出要求（你的最终回答会被直接贴到 PR 评论）`,
    `用中文 Markdown 输出：第一行为结论「✅ 建议合并」或「⚠️ 建议修改」；`,
    `之后分条列出发现的问题（文件:行号 + 说明 + 建议），没有问题则简述验证了哪些点。不要修改任何代码。`,
  ].join("\n");
}

async function runReviewTask(taskId: number) {
  const task = getAgentTask(taskId);
  if (!task) throw new Error("任务不存在");
  const req = getRequirement(task.requirementId);
  if (!req) throw new Error("需求不存在");
  if (!req.branch || !req.prNumber) throw new Error("该需求尚无 PR，无法审查");
  const branch = req.branch;

  const logDir = path.join(DATA_DIR, "agent-logs");
  fs.mkdirSync(logDir, { recursive: true });
  const logPath = path.join(logDir, `task-${task.id}.log`);
  const log = fs.openSync(logPath, "a");
  const logLine = (s: string) => fs.writeSync(log, `\n===== [portal] ${s} =====\n`);

  const workspace = repoWorkspaceDir(req.repo);
  updateAgentTask(task.id, { status: "running", logPath, workspace, step: "guard" });
  addEvent(req.id, "review_started", "system", `Codex 审查任务 #${task.id} 启动（PR #${req.prNumber}）`);

  try {
    await ensureGuardApproved(req.id); // 防滥用门审

    // 共享工作区：切到 PR 分支 + 增量索引
    updateAgentTask(task.id, { step: "clone" });
    logLine(`prepare workspace ${req.repo} @ ${branch}`);
    const { indexed } = await prepareRepoWorkspace(req.repo, { branch, useExistingBranch: true });
    const cgHint = codegraphHint(indexed);

    updateAgentTask(task.id, { step: "review" });
    logLine(`run ${task.engine} review`);
    const engine = ENGINES[task.engine];
    const outFile = path.join(workspace, ".review-result.md");
    const prompt = buildReviewPrompt(req, await getDefaultBranch(req.repo)) + cgHint;
    // codex 用 --output-last-message 捕获最终结论；claude -p 的 stdout 即结论
    let result: string;
    if (task.engine === "codex") {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(
          engine.cmd,
          ["exec", "--full-auto", "--output-last-message", outFile, prompt],
          { cwd: workspace, env: { ...process.env }, stdio: ["ignore", log, log] }
        );
        updateAgentTask(task.id, { pid: child.pid ?? null });
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error("审查超时"));
        }, TIMEOUT_MS);
        child.on("error", (e) => (clearTimeout(timer), reject(e)));
        child.on("exit", (code) =>
          code === 0
            ? (clearTimeout(timer), resolve())
            : (clearTimeout(timer), reject(new Error(`codex 退出码 ${code}`)))
        );
      });
      result = fs.readFileSync(outFile, "utf-8");
      fs.rmSync(outFile, { force: true });
    } else {
      const { stdout } = await execFileP(engine.cmd, ["-p", prompt, "--dangerously-skip-permissions"], {
        cwd: workspace,
        timeout: TIMEOUT_MS,
        maxBuffer: 10 * 1024 * 1024,
      });
      result = stdout;
    }
    result = result.trim();
    if (!result) throw new Error("审查无输出");

    // 建议写回 PR 评论
    updateAgentTask(task.id, { step: "comment" });
    const [owner, name] = req.repo.split("/");
    const gh = new Octokit({ auth: process.env.GITHUB_TOKEN });
    await gh.issues.createComment({
      owner,
      repo: name,
      issue_number: req.prNumber,
      body: `## 🧐 自动代码审查（${task.engine}）\n\n${result}\n\n---\n_由需求门户本地 Agent 审查生成 · 门户需求 #${req.id}_`,
    });

    updateAgentTask(task.id, {
      status: "succeeded",
      step: "done",
      pid: null,
      result: result.slice(0, 4000),
    });

    // 解析结论并驱动闭环：建议修改 → 自动把意见喂回编码 agent 修改，直到通过或达上限
    const verdict = parseReviewVerdict(result);
    updateRequirement(req.id, { reviewVerdict: verdict, reviewFeedback: result.slice(0, 6000) });
    addEvent(
      req.id,
      "review_done",
      "system",
      `审查完成（${verdict === "approved" ? "建议合并" : verdict === "changes" ? "建议修改" : "结论未识别"}），已评论到 PR #${req.prNumber}`
    );
    logLine(`review done: ${verdict}`);

    if (verdict === "changes") {
      const cur = getRequirement(req.id)!;
      if (AUTO_FIX && cur.fixRounds < MAX_FIX_ROUNDS) {
        const round = cur.fixRounds + 1;
        updateRequirement(req.id, { fixRounds: round });
        try {
          // 修复沿用需求原执行方案（引擎/模型/强度）
          const plan = cur.execPlan;
          const engine = plan?.engine ?? process.env.AGENT_ENGINE ?? "claude";
          const t = enqueueDevTask(req.id, ENGINES[engine] ? engine : "claude", {
            model: plan?.model,
            effort: plan?.effort as Effort | undefined,
          });
          addEvent(
            req.id,
            "fix_enqueued",
            "system",
            `审查建议修改，自动触发第 ${round}/${MAX_FIX_ROUNDS} 轮修复（${t.engine}）`
          );
        } catch (e) {
          console.error("自动修复入队失败:", e);
        }
      } else {
        addEvent(
          req.id,
          "fix_maxed",
          "system",
          `审查仍建议修改，已达最大自动修复轮次（${MAX_FIX_ROUNDS}），请人工处理`
        );
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    updateAgentTask(task.id, { status: "failed", error: message, pid: null });
    addEvent(req.id, "review_failed", "system", `审查任务 #${task.id} 失败：${message}`);
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
