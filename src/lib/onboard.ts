import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import {
  finishRepoModuleMap,
  getRepoById,
  replaceRepoModuleCandidates,
  repoModuleMapConfirmed,
  updateRepoOnboard,
} from "./db";
import { ENGINES } from "./agent-runner";
import { parseRepoModuleCandidates, type RepoModuleCandidate } from "./module-map";
import { prepareRepoWorkspace, repoWorkspaceDir } from "./repo-index";
import { getDefaultBranch, openDocsPr, providerConfigured } from "./repo-provider";

// 仓库入驻：加入门户时后台执行——建持久 codegraph 索引 + 分析生成/补齐 agent.md 并开 PR。
// 完成前该仓库不能启动开发任务（门禁见 actions 路由）。

const ONBOARD_ENGINE = process.env.AGENT_ONBOARD_ENGINE ?? "claude";
const AGENT_MD_BRANCH = "chore/agent-md-onboarding";

// agent.md 必备内容清单（与 github-templates/agent.md.example 对齐）
const REQUIRED_SECTIONS = `
1. 项目一句话定位与形态
2. 代码地图（目录树 + 每个目录职责 + 入口，务必反映真实结构）
3. 必须模仿的核心模式（贴 1-3 段本仓库真实代码作范本）
4. 新增一个功能的配方（分步）
5. 命名与文件布局约定
6. 风格由工具强制（列出 lint/format 命令；无则注明"建议引入"）
7. 命令速查（install/dev/test/lint/build）
8. 测试（严格 TDD：测试先行，每条验收用例带 TC 编号）
9. 分支与提交（一需求=一Issue=一分支 feature/req-<门户ID>-issue-<Issue号>=一PR；禁止直推；PR 含 Closes #issue；提交信息中文 feat(<模块>): <说明> (#<issue>)）
10. 禁区与反模式（会被评审打回的做法）
11. 踩坑与经验`;

function buildOnboardPrompt(hasExisting: boolean, indexed: boolean): string {
  return [
    `你是研发效能平台的仓库分析器。请为【当前仓库】产出一份给 AI 开发 Agent 用的 \`agent.md\` 项目说明书。`,
    indexed
      ? `本仓库已建好 codegraph 索引，请用它理解代码：\`codegraph explore <关键词>\`、\`codegraph query <符号>\`、\`codegraph files\`、\`codegraph node <符号>\`。`
      : ``,
    ``,
    `# 必须包含的章节（缺一不可，内容要基于真实代码，不要写占位）`,
    REQUIRED_SECTIONS,
    ``,
    hasExisting
      ? `仓库根目录【已有】agent.md（见工作区）。请检查它是否覆盖了上述所有章节与规则：\n` +
        `- 已覆盖且准确的内容予以保留；\n- 缺失或不符合上述要求的，补齐/修正。\n` +
        `产出【完整】的最终 agent.md（不是 diff）。`
      : `仓库根目录【没有】agent.md，请从零生成完整的一份。`,
    ``,
    `# 输出要求`,
    `只输出最终 agent.md 的 Markdown 正文，不要任何解释、代码块围栏或额外文字。首行以 "# agent.md" 开头。`,
  ]
    .filter(Boolean)
    .join("\n");
}

async function runOnboardPrompt(mirror: string, prompt: string, outputName: string): Promise<string> {
  const engine = ENGINES[ONBOARD_ENGINE];
  if (!engine) throw new Error(`未知入驻引擎：${ONBOARD_ENGINE}`);
  const timeout = 20 * 60_000;

  if (ONBOARD_ENGINE === "codex") {
    const outFile = path.join(mirror, outputName);
    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(engine.cmd, ["exec", "--full-auto", "--output-last-message", outFile, prompt], {
          cwd: mirror,
          stdio: ["ignore", "ignore", "pipe"],
        });
        const t = setTimeout(() => (child.kill("SIGKILL"), reject(new Error("生成超时"))), timeout);
        child.on("error", (e) => (clearTimeout(t), reject(e)));
        child.on("exit", (c) =>
          c === 0
            ? (clearTimeout(t), resolve())
            : (clearTimeout(t), reject(new Error(`codex 退出码 ${c}`)))
        );
      });
      return fs.readFileSync(outFile, "utf-8");
    } finally {
      fs.rmSync(outFile, { force: true });
    }
  }

  // claude -p：stdout 即结果
  const out = await new Promise<string>((resolve, reject) => {
    const child = spawn(engine.cmd, ["-p", prompt, "--dangerously-skip-permissions"], {
      cwd: mirror,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += String(d)));
    child.stderr.on("data", (d) => (stderr += String(d)));
    const t = setTimeout(() => (child.kill("SIGKILL"), reject(new Error("生成超时"))), timeout);
    child.on("error", (e) => (clearTimeout(t), reject(e)));
    child.on("exit", (c) =>
      c === 0
        ? (clearTimeout(t), resolve(stdout))
        : (clearTimeout(t), reject(new Error(`claude 退出码 ${c}: ${stderr.slice(-200)}`)))
    );
  });
  return out;
}

// 在镜像目录用本地 CLI 生成 agent.md 内容
async function generateAgentMd(
  mirror: string,
  hasExisting: boolean,
  indexed: boolean
): Promise<string> {
  const out = await runOnboardPrompt(
    mirror,
    buildOnboardPrompt(hasExisting, indexed),
    ".agent-md-draft"
  );
  return cleanAgentMd(out);
}

function buildModuleMapPrompt(indexed: boolean, agentMd: string): string {
  return [
    "你是研发效能平台的仓库架构分析器。请分析当前仓库，给出供需求归属判断使用的模块地图候选。",
    indexed
      ? "本仓库已有 codegraph 索引。先使用 codegraph files/explore/node 理解目录、入口和调用关系。"
      : "请直接阅读目录结构、构建配置和主要入口理解仓库。",
    "同时阅读根目录 agent.md、CLAUDE.md、AGENTS.md（存在时），不要只按目录名猜测。",
    "",
    "模块粒度必须贴合真实结构：优先按独立服务、前端业务模块、包或清晰职责目录划分。",
    "平台基础设施、共享组件或公共代码要单列为一个名为“公共”的模块，避免悄悄混入业务模块。",
    "paths 必须是仓库相对路径 glob（例如 apps/admin/**、packages/shared/**），禁止绝对路径和 ../。",
    "模块之间尽量不重叠；每个真实开发区域都应被覆盖，不要生成虚构目录。module_key 使用简短稳定的 ASCII kebab-case。",
    "",
    "只输出 JSON 数组，不要解释或代码围栏。每项字段严格为：",
    '{"module_key":"admin-web","name":"管理端前端","paths":["apps/admin/**"],"description":"职责与边界"}',
    agentMd
      ? `\n以下是本次入驻分析得到的 agent.md 内容，可辅助判断（仍须以真实代码为准）：\n${agentMd.slice(0, 20_000)}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

async function generateRepoModuleMap(
  mirror: string,
  indexed: boolean,
  agentMd: string
): Promise<RepoModuleCandidate[]> {
  const out = await runOnboardPrompt(
    mirror,
    buildModuleMapPrompt(indexed, agentMd),
    ".module-map-draft"
  );
  return parseRepoModuleCandidates(out);
}

// 截到正文；仅当【整体】被一层 ``` 包裹时才剥离（避免误伤正文里的代码块）
export function cleanAgentMd(raw: string): string {
  let s = raw.trim();
  if (s.startsWith("```")) {
    const firstNl = s.indexOf("\n");
    const lastFence = s.lastIndexOf("```");
    if (firstNl !== -1 && lastFence > firstNl) s = s.slice(firstNl + 1, lastFence).trim();
  }
  const idx = s.indexOf("# agent.md");
  if (idx > 0) s = s.slice(idx); // 去掉标题前的任何前言
  return s.trim() + "\n";
}

// 在新分支写入 agent.md + 引导文件并开 PR/MR（按仓库托管平台分派，GitHub/GitLab 均支持）。
// 关键：CLAUDE.md / AGENTS.md 若已存在（仓库可能用它们当主规范），一律不覆盖，只在缺失时补一个指针，
// 避免把维护者精心写好的规范冲掉。
async function openAgentMdPr(repoFullName: string, content: string, mirror: string): Promise<string> {
  const pointer = "开发规范见 [agent.md](agent.md)，动手前必须先完整阅读并严格遵循。\n";
  const files = [{ path: "agent.md", text: content }];
  for (const pf of ["CLAUDE.md", "AGENTS.md"]) {
    if (!fs.existsSync(path.join(mirror, pf))) files.push({ path: pf, text: pointer });
  }
  const keptNote =
    files.length < 3
      ? "\n\n注：检测到仓库已有 CLAUDE.md/AGENTS.md，已保留不动，仅新增/更新 agent.md。"
      : "";
  return openDocsPr(repoFullName, files, {
    branch: AGENT_MD_BRANCH,
    title: "docs: 新增/更新 agent.md（门户入驻自动生成）",
    body:
      "由需求门户在仓库入驻时自动分析生成/补齐，作为给 AI 开发 Agent 的项目说明书。\n\n请审阅后合并。合并后本仓库的开发/审查 Agent 都会遵循它。" +
      keptNote +
      "\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)",
  });
}

// runner 调用的入驻主流程
export async function runRepoOnboard(repoId: number): Promise<void> {
  const repo = getRepoById(repoId);
  if (!repo) return;
  try {
    // 1. 共享工作区（clone + 切默认分支 + codegraph 索引）
    updateRepoOnboard(repoId, { onboardStep: "建代码索引" });
    const base = await getDefaultBranch(repo.fullName);
    const { indexed } = await prepareRepoWorkspace(repo.fullName, { base });
    updateRepoOnboard(repoId, { indexedAt: new Date().toISOString().replace("T", " ").slice(0, 19) });

    // 2. agent.md：分析生成/补齐 → 开 PR/MR（best-effort，不阻塞就绪；GitHub/GitLab 均支持）
    let prUrl = "";
    const mirror = repoWorkspaceDir(repo.fullName);
    const existingAgentMd = path.join(mirror, "agent.md");
    let agentMdContext = fs.existsSync(existingAgentMd)
      ? fs.readFileSync(existingAgentMd, "utf-8").trim()
      : "";
    if (providerConfigured(repo.fullName)) {
      try {
        updateRepoOnboard(repoId, { onboardStep: "生成 agent.md" });
        const existingPath = existingAgentMd;
        const hasExisting = fs.existsSync(existingPath);
        const existing = hasExisting ? fs.readFileSync(existingPath, "utf-8").trim() : "";
        const content = await generateAgentMd(mirror, hasExisting, indexed);
        agentMdContext = content;
        // 已有且内容基本一致（已符合要求）→ 不开 PR
        if (!hasExisting || normalize(content) !== normalize(existing)) {
          prUrl = await openAgentMdPr(repo.fullName, content, mirror);
        }
      } catch (err) {
        console.error("agent.md 生成失败（索引已就绪，可手动处理）:", err);
      }
    }

    // 3. 模块地图候选：已确认地图不自动覆盖；失败不阻塞仓库就绪。
    if (!repoModuleMapConfirmed(repoId)) {
      try {
        updateRepoOnboard(repoId, { onboardStep: "生成模块地图" });
        const modules = await generateRepoModuleMap(mirror, indexed, agentMdContext);
        replaceRepoModuleCandidates(repoId, modules);
      } catch (err) {
        console.error("模块地图生成失败（仓库仍可使用，可在仓库管理中手动维护）:", err);
      }
    }

    updateRepoOnboard(repoId, {
      onboardStatus: "ready",
      onboardStep: "",
      onboardError: "",
      onboardPr: prUrl,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    updateRepoOnboard(repoId, { onboardStatus: "failed", onboardStep: "", onboardError: msg });
  }
}

// runner 调用的轻量任务：只重新生成模块地图，不重建索引、不碰 agent.md。
// 复用上次入驻建好的 workspace 与 codegraph 索引（skipIndex），耗时约几十秒。
export async function runRepoModuleMapOnly(repoId: number): Promise<void> {
  const repo = getRepoById(repoId);
  if (!repo) return;
  try {
    const base = await getDefaultBranch(repo.fullName);
    const { dir: mirror, indexed } = await prepareRepoWorkspace(repo.fullName, { base, skipIndex: true });
    const agentMdPath = path.join(mirror, "agent.md");
    const agentMdContext = fs.existsSync(agentMdPath) ? fs.readFileSync(agentMdPath, "utf-8").trim() : "";
    const modules = await generateRepoModuleMap(mirror, indexed, agentMdContext);
    replaceRepoModuleCandidates(repoId, modules);
  } catch (err) {
    console.error("重新生成模块地图失败:", err);
  } finally {
    finishRepoModuleMap(repoId);
  }
}

function normalize(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}
