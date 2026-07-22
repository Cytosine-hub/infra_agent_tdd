import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import fs from "node:fs";
import {
  addEvent,
  createAgentTask,
  getAgentTask,
  getRepoByName,
  getRequirement,
  listRepoModules,
  latestAgentTask,
  updateAgentTask,
  updateRequirementModuleSuggestion,
  updateRequirementReviewSuggestion,
  updateRequirement,
  type AgentTaskRow,
} from "./db";
import type { ModuleSuggestion, RepoModule, Requirement, ReviewSuggestion, TestCase } from "./types";
import { generateWithEngine, generateWithTemplate, testCasesToMarkdown } from "./testcase-gen";
import { ensureGuardApproved } from "./guard";
import { createOrGetPullRequest, getDefaultBranch, postPrComment } from "./repo-provider";
import { DATA_DIR, prepareRepoWorkspace, repoWorkspaceDir } from "./repo-index";
import { ensureUploadsDir, mockupPath, uploadsDir } from "./uploads";
import { listAttachments } from "./db";
import { normalizeRepoPaths } from "./module-map";

const execFileP = promisify(execFile);

// 本地 Agent 执行器：调用本机已登录的 Claude Code / Codex CLI 完成开发。
// 不走 Anthropic API 计费，复用客户端订阅额度；门户服务器需装有对应 CLI。
//
// 流程：clone(独立工作区) → 建分支 → 生成任务提示词 → 本地 CLI 开发(测试先行)
//     → runner 强制跑仓库测试 → 兜底提交 → push → 建 PR/MR（按仓库托管平台分派）→ 需求转入 in_review

export type Effort = "low" | "medium" | "high";

export interface ExecOptions {
  model?: string;
  effort?: Effort;
  fallback?: boolean; // 额度受限时自动切换备用引擎重试（启动时勾选）
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
      "claude-fable-5",
      "claude-opus-4-8",
      "claude-sonnet-5",
      "claude-haiku-4-5-20251001",
    ]),
    // -p 无头模式；stream-json 让开发过程实时写日志（前端"最新进度"可见），权限跳过仅作用于隔离工作区
    args: (prompt, opts) => [
      "-p",
      prompt,
      "--dangerously-skip-permissions",
      "--output-format",
      "stream-json",
      "--verbose",
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
    models: modelsFromEnv("AGENT_MODELS_CODEX", ["gpt-5.6", "gpt-5.5", "gpt-5.4"]),
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

// 解析审查结论（分级契约）：仅存在【阻断】问题 → changes 触发修复循环；
// 只有非阻断【建议】或无问题 → approved，停止继续开发。
export function parseReviewVerdict(result: string): "approved" | "changes" | "" {
  const head = (result || "").split(/\r?\n/).find((l) => l.trim())?.trim() ?? "";
  // 首选：首行的 [阻断]/[通过] 标签（提示词契约）
  if (/\[\s*阻断\s*\]/.test(head)) return "changes";
  if (/\[\s*通过\s*\]/.test(head)) return "approved";
  // 兜底（模型未按契约输出时的自由文本判定）
  if (/无阻断|建议合并|可以合并|可合并|approve/i.test(head)) return "approved";
  if (/存在阻断|阻断性|必须修改/.test(head)) return "changes";
  if (/建议修改|需要修改|不建议合并/.test(head) && !/合并/.test(head)) return "changes";
  if (/建议合并/.test(result)) return "approved";
  if (/【阻断】/.test(result)) return "changes";
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

export function buildPrompt(req: Requirement, codegraph = "", fixFeedback = ""): string {
  const fixMode = !!fixFeedback;
  const lockedScope =
    req.scopeLockedAt && req.scopePaths?.length
      ? [
          `## 已锁定开发范围`,
          `本需求归属模块：【${req.moduleKey || "未命名模块"}】。只在以下仓库相对路径内开发：`,
          ...req.scopePaths.map((scopePath) => `- \`${scopePath}\``),
          `如确需改动范围外或公共代码，必须先在最终说明中明确列出路径与原因，不得静默扩大范围。`,
          ``,
        ].join("\n")
      : "";
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
    lockedScope,
    `## 验收测试用例（必须全部满足）`,
    testCasesToMarkdown(req.testCases ?? []),
    ``,
    fixMode
      ? `## ⚠️ 上一轮代码审查意见\n${fixFeedback}\n\n> 修改范围：【阻断】项**必须逐条解决**；【建议】项可顺手处理但非必须，不要为其扩大改动面。`
      : ``,
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
function assertNoActiveTask(
  requirementId: number,
  kind: "develop" | "review" | "testcases" | "mockup" | "classify" | "suggest"
) {
  const last = latestAgentTask(requirementId, kind);
  if (
    last &&
    // running 且（无子进程 pid，即 runner 进程内跑，如用例生成 / 子进程仍存活）→ 视为活跃。
    // 崩溃残留的 running 任务由 runner 启动时 failStaleRunningTasks(pidAlive) 清理。
    (last.status === "queued" ||
      (last.status === "running" && (last.pid == null || pidAlive(last.pid))))
  ) {
    const label =
      kind === "develop"
        ? "开发"
        : kind === "review"
          ? "审查"
          : kind === "mockup"
            ? "渲染图"
            : kind === "classify"
              ? "模块识别"
              : kind === "suggest"
                ? "评审建议"
                : "用例生成";
    throw new Error(`该需求已有排队/进行中的${label}任务（#${last.id}）`);
  }
}

export function enqueueDevTask(
  requirementId: number,
  engine: string,
  opts: ExecOptions = {}
): AgentTaskRow {
  assertNoActiveTask(requirementId, "develop");
  return createAgentTask(
    requirementId,
    engine,
    opts.model ?? "",
    opts.effort ?? "",
    "develop",
    opts.fallback ? 1 : 0
  );
}

// PR 审查任务入队：默认 codex（可用 AGENT_REVIEW_ENGINE 覆盖），与开发引擎交叉互审
export function enqueueReviewTask(requirementId: number, engine?: string): AgentTaskRow {
  const reviewEngine = engine ?? process.env.AGENT_REVIEW_ENGINE ?? "codex";
  if (!ENGINES[reviewEngine]) throw new Error(`不支持的审查引擎：${reviewEngine}`);
  assertNoActiveTask(requirementId, "review");
  return createAgentTask(requirementId, reviewEngine, "", "", "review");
}

// 测试用例生成任务入队：默认 codex（TESTCASE_ENGINE 覆盖）
export function enqueueTestcaseTask(
  requirementId: number,
  engine?: string,
  extra = ""
): AgentTaskRow {
  const genEngine = engine ?? process.env.TESTCASE_ENGINE ?? "codex";
  if (!ENGINES[genEngine]) throw new Error(`不支持的用例生成引擎：${genEngine}`);
  assertNoActiveTask(requirementId, "testcases");
  return createAgentTask(requirementId, genEngine, "", "", "testcases", 0, extra);
}

// 前端渲染图任务入队：需求提交后自动触发，AI 判定是否前端需求并生成单文件 HTML 原型
export function enqueueMockupTask(
  requirementId: number,
  engine?: string,
  extra = ""
): AgentTaskRow {
  const mkEngine = engine ?? process.env.AGENT_MOCKUP_ENGINE ?? "codex";
  if (!ENGINES[mkEngine]) throw new Error(`不支持的渲染图引擎：${mkEngine}`);
  assertNoActiveTask(requirementId, "mockup");
  return createAgentTask(requirementId, mkEngine, "", "", "mockup", 0, extra);
}

// 需求模块识别：提交/重提后自动触发，与用例生成共用默认引擎约定。
export function enqueueClassifyTask(requirementId: number, engine?: string): AgentTaskRow {
  const classifyEngine =
    engine ?? process.env.AGENT_CLASSIFY_ENGINE ?? process.env.TESTCASE_ENGINE ?? "codex";
  if (!ENGINES[classifyEngine]) throw new Error(`不支持的模块识别引擎：${classifyEngine}`);
  assertNoActiveTask(requirementId, "classify");
  return createAgentTask(requirementId, classifyEngine, "", "", "classify");
}

// 需求评审建议：提交/重提后自动触发；组长改需求后可「重新评估」再触发。
export function enqueueSuggestTask(requirementId: number, engine?: string): AgentTaskRow {
  const suggestEngine =
    engine ?? process.env.AGENT_SUGGEST_ENGINE ?? process.env.TESTCASE_ENGINE ?? "codex";
  if (!ENGINES[suggestEngine]) throw new Error(`不支持的评审建议引擎：${suggestEngine}`);
  assertNoActiveTask(requirementId, "suggest");
  return createAgentTask(requirementId, suggestEngine, "", "", "suggest");
}

// 额度/限流类错误特征（claude 订阅 session limit、网关 429 等）
export function isQuotaError(message: string): boolean {
  return /session limit|usage limit|rate.?limit|hit your.*limit|quota|429|too many requests/i.test(
    message
  );
}

// runner 守护进程的任务分发入口
export async function executeTask(taskId: number): Promise<void> {
  const task = getAgentTask(taskId);
  if (!task) throw new Error(`任务 #${taskId} 不存在`);
  try {
    if (task.kind === "develop") await runTask(taskId);
    else if (task.kind === "review") await runReviewTask(taskId);
    else if (task.kind === "mockup") await runMockupTask(taskId);
    else if (task.kind === "classify") await runClassifyTask(taskId);
    else if (task.kind === "suggest") await runSuggestTask(taskId);
    else await runTestcaseTask(taskId);
  } catch (err) {
    const message = String(err);
    updateAgentTask(taskId, { status: "failed", error: message, pid: null });

    // 额度自动降级：勾选了 fallback 的开发任务遇额度类失败 → 自动用备用引擎重跑一次
    if (task.kind === "develop" && task.fallback && isQuotaError(message)) {
      const other = task.engine === "claude" ? "codex" : "claude";
      if (ENGINES[other]) {
        try {
          const t = createAgentTask(
            task.requirementId,
            other,
            ENGINES[other].models[0] ?? "",
            task.effort,
            "develop",
            0 // 备用引擎只重试一次，不再来回切换
          );
          addEvent(
            task.requirementId,
            "engine_fallback",
            "system",
            `${task.engine} 额度受限，自动切换备用引擎 ${other}/${t.model} 重试（任务 #${t.id}）`
          );
        } catch (e) {
          console.error("额度降级入队失败:", e);
        }
      }
    }
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

    // 1.5 需求附件（设计图/文档/渲染原型）拷入工作区，供 agent 查看参考
    let attHint = "";
    const atts = listAttachments(req.id);
    const attDir = path.join(workspace, ".portal-attachments");
    fs.rmSync(attDir, { recursive: true, force: true });
    const attFiles: string[] = [];
    for (const a of atts) {
      if (fs.existsSync(a.storedPath)) {
        fs.mkdirSync(attDir, { recursive: true });
        fs.copyFileSync(a.storedPath, path.join(attDir, a.filename));
        attFiles.push(a.filename);
      }
    }
    if (fs.existsSync(mockupPath(req.id))) {
      fs.mkdirSync(attDir, { recursive: true });
      fs.copyFileSync(mockupPath(req.id), path.join(attDir, "评审通过的前端渲染原型.html"));
      attFiles.push("评审通过的前端渲染原型.html");
    }
    if (attFiles.length > 0) {
      const excl = path.join(workspace, ".git", "info", "exclude");
      if (!fs.readFileSync(excl, "utf-8").includes(".portal-attachments/")) {
        fs.appendFileSync(excl, "\n.portal-attachments/\n");
      }
      attHint = `\n## 需求附件（位于 .portal-attachments/ 目录，图片/原型可直接查看参考，勿提交该目录）\n${attFiles.map((f) => `- ${f}`).join("\n")}`;
    }

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
      const child = spawn(engine.cmd, engine.args(buildPrompt(req, cgHint + attHint, fixFeedback), opts), {
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
        // 子进程已退出：立即清 pid，避免后续 verify/push 步骤被 pid 探活误判为中断
        updateAgentTask(task.id, { pid: null });
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
    const { number: prNumber, url: prUrl } = await createOrGetPullRequest(req, {
      branch,
      base: baseBranch,
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
    throw err; // 上抛给 executeTask 做额度降级判断
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
    cases = await generateWithEngine(req, task.engine, task.extra);
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

export function buildClassifyPrompt(req: Requirement, modules: RepoModule[]): string {
  const moduleJson = modules.map((module) => ({
    moduleKey: module.moduleKey,
    name: module.name,
    paths: module.paths,
    description: module.description,
  }));
  return [
    "你是需求评审阶段的模块范围分析器。根据需求与仓库模块地图，判断主要归属模块和建议开发路径。",
    "moduleKey 必须严格选自模块地图，不得虚构。scopePaths 必须是仓库相对路径 glob；默认直接使用所选模块 paths，可在证据充分时缩小。",
    "如需求明显跨模块或需要公共代码，在 rationale 中明确指出需拆分或由组长显式授权额外路径，但仍选择一个主要模块。",
    "只输出一个 JSON 对象，不要解释或代码围栏：",
    '{"moduleKey":"模块 key","rationale":"判断依据","confidence":0.85,"scopePaths":["path/**"]}',
    "",
    `需求标题：${req.title}`,
    `需求描述：${req.description}`,
    req.testScenarios ? `核心场景：${req.testScenarios}` : "",
    `模块地图：${JSON.stringify(moduleJson)}`,
  ]
    .filter(Boolean)
    .join("\n");
}

export function parseModuleSuggestion(raw: string, modules: RepoModule[]): ModuleSuggestion {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("模块识别输出中未找到 JSON 对象");
  const value = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
  const moduleKey = typeof value.moduleKey === "string" ? value.moduleKey.trim() : "";
  const selected = modules.find((module) => module.moduleKey === moduleKey);
  if (!selected) throw new Error(`模块识别返回未知 moduleKey：${moduleKey || "（空）"}`);
  const rawConfidence = typeof value.confidence === "number" ? value.confidence : 0;
  const scopePaths = normalizeRepoPaths(value.scopePaths);
  return {
    moduleKey,
    rationale:
      typeof value.rationale === "string" && value.rationale.trim()
        ? value.rationale.trim().slice(0, 2000)
        : "AI 未提供判断理由",
    confidence: Math.min(1, Math.max(0, rawConfidence)),
    scopePaths: scopePaths.length > 0 ? scopePaths : selected.paths,
  };
}

async function runClassifyEngine(
  task: AgentTaskRow,
  prompt: string,
  cwd: string
): Promise<string> {
  const engine = ENGINES[task.engine];
  if (!engine) throw new Error(`未知模块识别引擎：${task.engine}`);
  const outFile = path.join(cwd, `classify-${task.id}-${Date.now()}.json`);
  try {
    return await new Promise<string>((resolve, reject) => {
      const args =
        task.engine === "codex"
          ? ["exec", "--skip-git-repo-check", "--output-last-message", outFile, prompt]
          : ["-p", prompt];
      const child = spawn(engine.cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
      updateAgentTask(task.id, { pid: child.pid ?? null });
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (data) => (stdout += String(data)));
      child.stderr?.on("data", (data) => (stderr += String(data)));
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("模块识别超时"));
      }, 3 * 60_000);
      child.on("error", (error) => (clearTimeout(timer), reject(error)));
      child.on("exit", (code) => {
        clearTimeout(timer);
        updateAgentTask(task.id, { pid: null });
        if (code !== 0) return reject(new Error(`${task.engine} 退出码 ${code}: ${stderr.slice(-300)}`));
        resolve(task.engine === "codex" ? fs.readFileSync(outFile, "utf-8") : stdout);
      });
    });
  } finally {
    fs.rmSync(outFile, { force: true });
  }
}

// 模块识别失败只让本辅助任务失败，不改变需求状态或其他任务。
export async function runClassifyTask(taskId: number): Promise<void> {
  const task = getAgentTask(taskId);
  if (!task) throw new Error("任务不存在");
  const req = getRequirement(task.requirementId);
  if (!req) throw new Error("需求不存在");
  updateAgentTask(task.id, { status: "running", step: "guard" });
  addEvent(req.id, "classify_started", "system", `模块识别任务 #${task.id}（${task.engine}）启动`);
  try {
    await ensureGuardApproved(req.id);
    const repo = getRepoByName(req.repo);
    if (!repo) throw new Error("需求所属仓库不存在");
    const allModules = listRepoModules(repo.id);
    const confirmed = allModules.filter((repoModule) => repoModule.confirmed === 1);
    const modules = confirmed.length > 0 ? confirmed : allModules;
    if (modules.length === 0) throw new Error("仓库尚无模块地图，等待维护者在仓库管理中补充");
    updateAgentTask(task.id, { step: "classify" });
    const tempDir = path.join(DATA_DIR, "tmp");
    fs.mkdirSync(tempDir, { recursive: true });
    const raw = await runClassifyEngine(task, buildClassifyPrompt(req, modules), tempDir);
    const suggestion = parseModuleSuggestion(raw, modules);
    updateRequirementModuleSuggestion(req.id, suggestion);
    updateAgentTask(task.id, {
      status: "succeeded",
      step: "done",
      result: `建议模块：${suggestion.moduleKey}（置信度 ${Math.round(suggestion.confidence * 100)}%）`,
    });
    addEvent(
      req.id,
      "classify_succeeded",
      "system",
      `AI 建议归属模块 ${suggestion.moduleKey}，等待组长确认范围`
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    addEvent(req.id, "classify_failed", "system", `模块识别失败（不阻塞评审）：${message}`);
    throw error;
  }
}

export function buildSuggestPrompt(req: Requirement, modules: RepoModule[]): string {
  const moduleBrief = modules.map((m) => ({
    moduleKey: m.moduleKey,
    name: m.name,
    description: m.description,
  }));
  return [
    "你是资深需求评审专家。请对下面这条待评审需求【本身】做质量评估，帮助组长判断是否可进入开发。",
    "针对以下维度各给一句简短评价（中文，指出问题或确认没问题）：",
    "clarity 清晰度、completeness 完整性、feasibility 可行性、testability 可测性、risks 风险、scope 范围提示。",
    "再给出 readiness 总体就绪度：ready(可开发) 或 needs_work(需完善)；summary 一句话总评；suggestions 具体改进条目（数组，无则空数组）。",
    "只输出一个 JSON 对象，不要解释或代码围栏：",
    '{"readiness":"needs_work","summary":"…","dimensions":{"clarity":"…","completeness":"…","feasibility":"…","testability":"…","risks":"…","scope":"…"},"suggestions":["…"]}',
    "",
    `需求标题：${req.title}`,
    `优先级：${req.priority}`,
    `需求描述：${req.description}`,
    req.testScenarios ? `需求方核心测试场景：${req.testScenarios}` : "",
    moduleBrief.length ? `目标仓库模块地图（供可行性/范围参考）：${JSON.stringify(moduleBrief)}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export function parseReviewSuggestionOutput(raw: string): ReviewSuggestion {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("评审建议输出中未找到 JSON 对象");
  const v = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
  const dim = (v.dimensions ?? {}) as Record<string, unknown>;
  const s = (k: string) => (typeof dim[k] === "string" ? String(dim[k]).slice(0, 1000) : "");
  const summary = typeof v.summary === "string" ? v.summary.slice(0, 1000) : "";
  if (!summary) throw new Error("评审建议缺少 summary");
  return {
    readiness: v.readiness === "ready" ? "ready" : "needs_work",
    summary,
    dimensions: {
      clarity: s("clarity"),
      completeness: s("completeness"),
      feasibility: s("feasibility"),
      testability: s("testability"),
      risks: s("risks"),
      scope: s("scope"),
    },
    suggestions: Array.isArray(v.suggestions)
      ? v.suggestions.filter((x): x is string => typeof x === "string").slice(0, 20)
      : [],
  };
}

// 评审建议：AI 评估需求本身质量（best-effort，失败只让本任务失败，不改需求状态）。
export async function runSuggestTask(taskId: number): Promise<void> {
  const task = getAgentTask(taskId);
  if (!task) throw new Error("任务不存在");
  const req = getRequirement(task.requirementId);
  if (!req) throw new Error("需求不存在");
  updateAgentTask(task.id, { status: "running", step: "suggest" });
  addEvent(req.id, "suggest_started", "system", `评审建议任务 #${task.id}（${task.engine}）启动`);
  try {
    await ensureGuardApproved(req.id);
    const repo = getRepoByName(req.repo);
    const modules = repo ? listRepoModules(repo.id) : [];
    const tempDir = path.join(DATA_DIR, "tmp");
    fs.mkdirSync(tempDir, { recursive: true });
    const rawOut = await runClassifyEngine(task, buildSuggestPrompt(req, modules), tempDir);
    const suggestion = parseReviewSuggestionOutput(rawOut);
    updateRequirementReviewSuggestion(req.id, suggestion);
    updateAgentTask(task.id, {
      status: "succeeded",
      step: "done",
      result: `就绪度：${suggestion.readiness === "ready" ? "可开发" : "需完善"}`,
    });
    addEvent(
      req.id,
      "suggest_succeeded",
      "system",
      `AI 评审建议已生成（${suggestion.readiness === "ready" ? "可开发" : "需完善"}）`
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    addEvent(req.id, "suggest_failed", "system", `评审建议生成失败（不阻塞评审）：${message}`);
    throw error;
  }
}

// 前端渲染图任务：AI 判定是否前端需求；是则生成单文件 HTML 原型供评审预览
async function runMockupTask(taskId: number) {
  const task = getAgentTask(taskId);
  if (!task) throw new Error("任务不存在");
  const req = getRequirement(task.requirementId);
  if (!req) throw new Error("需求不存在");

  updateAgentTask(task.id, { status: "running", step: "guard" });
  await ensureGuardApproved(req.id); // 防滥用门审（未过审的需求不烧渲染额度）

  updateAgentTask(task.id, { step: "mockup" });
  addEvent(req.id, "mockup_task_started", "system", `渲染图任务 #${task.id}（${task.engine}）启动`);

  const dir = ensureUploadsDir(req.id);
  const atts = listAttachments(req.id);
  const prompt = [
    "你是前端原型设计师。先判断下述需求是否涉及前端界面/页面/组件的改动：",
    "- 若【不涉及】前端 UI（纯后端/脚本/数据库等），只输出四个字母：SKIP",
    "- 若【涉及】，输出一个完整的单文件 HTML 原型：内联 CSS（可少量内联 JS），使用贴近需求的模拟数据，",
    "  中文界面，布局风格现代简洁，尽量还原需求描述的界面效果。只输出 HTML，以 <!DOCTYPE html> 开头，不要任何解释或代码围栏。",
    "",
    `需求标题：${req.title}`,
    `需求描述：${req.description}`,
    req.testScenarios ? `核心场景：${req.testScenarios}` : "",
    task.extra ? `⚠️ 本次重新生成的补充要求（必须满足）：${task.extra}` : "",
    atts.length
      ? `需求附件（当前目录下可直接查看，图片请参考其设计）：${atts.map((a) => path.basename(a.storedPath)).join("、")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");

  // 在附件目录执行，agent 可读取图片附件作为参考
  let out: string;
  if (task.engine === "codex") {
    const outFile = path.join(dir, ".mockup-out");
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        "codex",
        ["exec", "--skip-git-repo-check", "--output-last-message", outFile, prompt],
        { cwd: dir, stdio: ["ignore", "ignore", "pipe"] }
      );
      updateAgentTask(task.id, { pid: child.pid ?? null });
      const t = setTimeout(() => (child.kill("SIGKILL"), reject(new Error("渲染图生成超时"))), 10 * 60_000);
      child.on("error", (e) => (clearTimeout(t), reject(e)));
      child.on("exit", (c) => {
        clearTimeout(t);
        updateAgentTask(task.id, { pid: null });
        c === 0 ? resolve() : reject(new Error(`codex 退出码 ${c}`));
      });
    });
    out = fs.readFileSync(outFile, "utf-8");
    fs.rmSync(outFile, { force: true });
  } else {
    const r = await execFileP("claude", ["-p", prompt, "--dangerously-skip-permissions"], {
      cwd: dir,
      timeout: 10 * 60_000,
      maxBuffer: 20 * 1024 * 1024,
    });
    out = r.stdout;
  }

  const trimmed = out.trim();
  if (/^SKIP\b/m.test(trimmed.slice(0, 200)) && !/<!DOCTYPE|<html/i.test(trimmed)) {
    fs.rmSync(mockupPath(req.id), { force: true });
    updateAgentTask(task.id, { status: "succeeded", step: "done", result: "AI 判定非前端需求，未生成渲染图" });
    addEvent(req.id, "mockup_skipped", "system", "AI 判定非前端需求，未生成渲染图");
    return;
  }
  const start = trimmed.search(/<!DOCTYPE|<html/i);
  if (start < 0) throw new Error("渲染图输出中未找到 HTML");
  let html = trimmed.slice(start);
  const endIdx = html.lastIndexOf("</html>");
  if (endIdx > 0) html = html.slice(0, endIdx + 7);
  fs.writeFileSync(mockupPath(req.id), html, "utf-8");
  updateAgentTask(task.id, { status: "succeeded", step: "done", result: `已生成前端渲染图（${Math.round(html.length / 1024)}KB）` });
  addEvent(req.id, "mockup_generated", "system", "前端渲染图已生成，可在需求详情预览");
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
    `# 严重程度分级（关键）`,
    `- 【阻断】：功能不正确、验收用例未覆盖或测试未通过、安全问题、破坏现有功能、严重违反 agent.md 规范。必须修改才能合并。`,
    `- 【建议】：代码风格、命名、可读性、小优化、主观偏好等。**不影响合并**，不要因这类问题要求修改。`,
    `判定从严：拿不准或属主观偏好的一律归【建议】。`,
    ``,
    `# 输出要求（你的最终回答会被直接贴到 PR 评论）`,
    `第一行必须严格是下列之一（按是否存在【阻断】项判定，标签原样输出）：`,
    `- \`[阻断] 建议修改\` —— 存在至少一个【阻断】问题`,
    `- \`[通过] 建议合并\` —— 无【阻断】问题（可以有若干【建议】）`,
    `之后分条列出发现，每条以【阻断】或【建议】开头，注明 文件:行号 + 说明 + 修改建议；无任何问题写「未发现问题」。不要修改任何代码。`,
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
        child.on("exit", (code) => {
          clearTimeout(timer);
          // 子进程已退出：清 pid，避免 comment 步骤被 pid 探活误判为中断
          updateAgentTask(task.id, { pid: null });
          code === 0 ? resolve() : reject(new Error(`codex 退出码 ${code}`));
        });
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
    await postPrComment(
      req,
      `## 🧐 自动代码审查（${task.engine}）\n\n${result}\n\n---\n_由需求门户本地 Agent 审查生成 · 门户需求 #${req.id}_`
    );

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
      `审查完成（${verdict === "approved" ? "无阻断，可合并" : verdict === "changes" ? "存在阻断问题" : "结论未识别"}），已评论到 PR #${req.prNumber}`
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
