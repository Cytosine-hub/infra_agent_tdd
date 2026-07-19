import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { Octokit } from "@octokit/rest";
import { getRepoById, updateRepoOnboard } from "./db";
import { ENGINES } from "./agent-runner";
import { buildMirrorIndex, repoMirrorDir, codegraphAvailable } from "./repo-index";
import { getDefaultBranch } from "./github";

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

// 在镜像目录用本地 CLI 生成 agent.md 内容
async function generateAgentMd(
  mirror: string,
  hasExisting: boolean,
  indexed: boolean
): Promise<string> {
  const engine = ENGINES[ONBOARD_ENGINE];
  if (!engine) throw new Error(`未知入驻引擎：${ONBOARD_ENGINE}`);
  const prompt = buildOnboardPrompt(hasExisting, indexed);
  const timeout = 20 * 60_000;

  if (ONBOARD_ENGINE === "codex") {
    const outFile = path.join(mirror, ".agent-md-draft");
    await new Promise<void>((resolve, reject) => {
      const child = spawn(engine.cmd, ["exec", "--full-auto", "--output-last-message", outFile, prompt], {
        cwd: mirror,
        stdio: ["ignore", "ignore", "pipe"],
      });
      const t = setTimeout(() => (child.kill("SIGKILL"), reject(new Error("生成超时"))), timeout);
      child.on("error", (e) => (clearTimeout(t), reject(e)));
      child.on("exit", (c) =>
        c === 0 ? (clearTimeout(t), resolve()) : (clearTimeout(t), reject(new Error(`codex 退出码 ${c}`)))
      );
    });
    const out = fs.readFileSync(outFile, "utf-8");
    fs.rmSync(outFile, { force: true });
    return cleanAgentMd(out);
  }

  // claude -p：stdout 即结果
  const out = await new Promise<string>((resolve, reject) => {
    const child = spawn("claude", ["-p", prompt, "--dangerously-skip-permissions"], {
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
  return cleanAgentMd(out);
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

function octokit(): Octokit {
  return new Octokit({ auth: process.env.GITHUB_TOKEN });
}

// 通过 GitHub API 在新分支上写入 agent.md + 引导文件，开 PR
async function openAgentMdPr(repoFullName: string, content: string): Promise<string> {
  const gh = octokit();
  const [owner, repo] = repoFullName.split("/");
  const base = await getDefaultBranch(repoFullName);
  const baseRef = await gh.git.getRef({ owner, repo, ref: `heads/${base}` });
  const baseSha = baseRef.data.object.sha;

  // 新建/重置分支
  await gh.git
    .createRef({ owner, repo, ref: `refs/heads/${AGENT_MD_BRANCH}`, sha: baseSha })
    .catch(async () => {
      await gh.git.updateRef({ owner, repo, ref: `heads/${AGENT_MD_BRANCH}`, sha: baseSha, force: true });
    });

  const putFile = async (filePath: string, text: string) => {
    let sha: string | undefined;
    try {
      const existing = await gh.repos.getContent({ owner, repo, path: filePath, ref: AGENT_MD_BRANCH });
      if (!Array.isArray(existing.data) && "sha" in existing.data) sha = existing.data.sha;
    } catch {
      /* 文件不存在 */
    }
    await gh.repos.createOrUpdateFileContents({
      owner,
      repo,
      path: filePath,
      branch: AGENT_MD_BRANCH,
      message: `docs: 入驻自动生成/更新 ${filePath}`,
      content: Buffer.from(text, "utf-8").toString("base64"),
      sha,
    });
  };

  await putFile("agent.md", content);
  const pointer = "开发规范见 [agent.md](agent.md)，动手前必须先完整阅读并严格遵循。\n";
  await putFile("CLAUDE.md", pointer);
  await putFile("AGENTS.md", pointer);

  // 已有同分支 PR 则复用
  const existing = await gh.pulls.list({ owner, repo, head: `${owner}:${AGENT_MD_BRANCH}`, state: "open" });
  if (existing.data.length > 0) return existing.data[0].html_url;
  const pr = await gh.pulls.create({
    owner,
    repo,
    base,
    head: AGENT_MD_BRANCH,
    title: "docs: 新增/更新 agent.md（门户入驻自动生成）",
    body:
      "由需求门户在仓库入驻时自动分析生成/补齐，作为给 AI 开发 Agent 的项目说明书。\n\n请审阅后合并。合并后本仓库的开发/审查 Agent 都会遵循它。\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)",
  });
  return pr.data.html_url;
}

// runner 调用的入驻主流程
export async function runRepoOnboard(repoId: number): Promise<void> {
  const repo = getRepoById(repoId);
  if (!repo) return;
  try {
    // 1. 持久镜像 + codegraph 索引
    updateRepoOnboard(repoId, { onboardStep: "建代码索引" });
    await buildMirrorIndex(repo.fullName);
    const indexed = await codegraphAvailable();
    updateRepoOnboard(repoId, { indexedAt: new Date().toISOString().replace("T", " ").slice(0, 19) });

    // 2. agent.md：分析生成/补齐 → 开 PR（best-effort，不阻塞就绪）
    let prUrl = "";
    if (process.env.GITHUB_TOKEN) {
      try {
        updateRepoOnboard(repoId, { onboardStep: "生成 agent.md" });
        const mirror = repoMirrorDir(repo.fullName);
        const existingPath = path.join(mirror, "agent.md");
        const hasExisting = fs.existsSync(existingPath);
        const existing = hasExisting ? fs.readFileSync(existingPath, "utf-8").trim() : "";
        const content = await generateAgentMd(mirror, hasExisting, indexed);
        // 已有且内容基本一致（已符合要求）→ 不开 PR
        if (!hasExisting || normalize(content) !== normalize(existing)) {
          prUrl = await openAgentMdPr(repo.fullName, content);
        }
      } catch (err) {
        console.error("agent.md 生成失败（索引已就绪，可手动处理）:", err);
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

function normalize(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}
