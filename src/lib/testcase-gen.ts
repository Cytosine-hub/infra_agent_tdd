import Anthropic from "@anthropic-ai/sdk";
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import type { Requirement, TestCase } from "./types";

// codex exec 会等待 stdin 关闭，必须用 stdio ignore/pipe 启动（不能给 stdin 留管道）
function runCli(cmd: string, args: string[], cwd: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => (stdout += String(d)));
    child.stderr?.on("data", (d) => (stderr += String(d)));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${cmd} 超时（${timeoutMs / 1000}s）`));
    }, timeoutMs);
    child.on("error", (e) => (clearTimeout(timer), reject(e)));
    child.on("exit", (code) => {
      clearTimeout(timer);
      code === 0
        ? resolve(stdout)
        : reject(new Error(`${cmd} 退出码 ${code}: ${stderr.slice(-300)}`));
    });
  });
}

// 基于需求生成测试用例。生成链路（依次兜底）：
// 1. 本地 Codex CLI（默认，走客户端认证，无需 Anthropic API Key）
// 2. Anthropic API（配置了 ANTHROPIC_API_KEY 时）
// 3. 本地模板（离线兜底，规则拼装）
export async function generateTestCases(req: Requirement): Promise<{
  testCases: TestCase[];
  source: "codex" | "claude" | "template";
}> {
  try {
    return { testCases: await generateWithCodex(req), source: "codex" };
  } catch (err) {
    console.error("Codex 生成测试用例失败，尝试下一级:", err);
  }
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      return { testCases: await generateWithClaude(req), source: "claude" };
    } catch (err) {
      console.error("Claude 生成测试用例失败，回退到模板生成:", err);
    }
  }
  return { testCases: generateWithTemplate(req), source: "template" };
}

function genPrompt(req: Requirement): string {
  return [
    "你是一名资深测试工程师，为运维门户网站的功能需求编写验收测试用例。",
    "输出一个 JSON 数组，每个元素包含字段：id（如 TC-01）、title、precondition、steps（字符串数组）、expected。",
    "用例要覆盖正常路径、边界条件和异常路径，通常 4-8 条。只输出 JSON 数组，不要输出其他任何内容。",
    "",
    `需求标题：${req.title}`,
    `所属小组：${req.team}`,
    `需求描述：\n${req.description}`,
    req.testScenarios ? `需求方给出的核心测试场景：\n${req.testScenarios}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function parseTestCases(text: string): TestCase[] {
  const jsonText = text.slice(text.indexOf("["), text.lastIndexOf("]") + 1);
  const parsed = JSON.parse(jsonText) as TestCase[];
  if (!Array.isArray(parsed) || parsed.length === 0) throw new Error("解析结果为空");
  return parsed.map((tc, i) => ({
    id: tc.id || `TC-${String(i + 1).padStart(2, "0")}`,
    title: tc.title,
    precondition: tc.precondition ?? "",
    steps: Array.isArray(tc.steps) ? tc.steps : [String(tc.steps)],
    expected: tc.expected,
  }));
}

// 指定引擎生成（runner 任务用）：codex / claude 本地 CLI
export async function generateWithEngine(req: Requirement, engine: string): Promise<TestCase[]> {
  if (engine === "codex") return generateWithCodex(req);
  if (engine === "claude") {
    const tmpDir = path.join(process.env.DATA_DIR ?? path.join(process.cwd(), "data"), "tmp");
    fs.mkdirSync(tmpDir, { recursive: true });
    const stdout = await runCli("claude", ["-p", genPrompt(req)], tmpDir, 180_000);
    return parseTestCases(stdout);
  }
  throw new Error(`不支持的用例生成引擎：${engine}`);
}

// 本地 Codex CLI 生成（codex exec 无头模式，最终回答写入文件）
async function generateWithCodex(req: Requirement): Promise<TestCase[]> {
  const tmpDir = path.join(process.env.DATA_DIR ?? path.join(process.cwd(), "data"), "tmp");
  fs.mkdirSync(tmpDir, { recursive: true });
  const outFile = path.join(tmpDir, `testcases-${req.id}-${Date.now()}.md`);
  try {
    await runCli(
      "codex",
      ["exec", "--skip-git-repo-check", "--output-last-message", outFile, genPrompt(req)],
      tmpDir,
      180_000
    );
    return parseTestCases(fs.readFileSync(outFile, "utf-8"));
  } finally {
    fs.rmSync(outFile, { force: true });
  }
}

async function generateWithClaude(req: Requirement): Promise<TestCase[]> {
  const client = new Anthropic();
  const msg = await client.messages.create({
    model: process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5",
    max_tokens: 4096,
    messages: [{ role: "user", content: genPrompt(req) }],
  });
  const text = msg.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
  return parseTestCases(text);
}

// 无 API Key 时的本地兜底：从需求描述与核心场景推导基础用例骨架，供人工修订
export function generateWithTemplate(req: Requirement): TestCase[] {
  const cases: TestCase[] = [];
  let n = 0;
  const nextId = () => `TC-${String(++n).padStart(2, "0")}`;

  // 需求方给的每个核心场景转成一条用例
  const scenarios = req.testScenarios
    .split(/\r?\n/)
    .map((s) => s.replace(/^[-*\d.、\s]+/, "").trim())
    .filter(Boolean);
  for (const s of scenarios) {
    cases.push({
      id: nextId(),
      title: s,
      precondition: "系统正常运行，测试账号已登录",
      steps: [`按场景描述操作：${s}`, "观察系统行为与输出"],
      expected: "行为符合需求描述，无报错",
    });
  }

  cases.push(
    {
      id: nextId(),
      title: `${req.title} - 正常路径验证`,
      precondition: "系统正常运行，测试账号已登录",
      steps: ["使用合法输入执行完整功能流程", "检查结果页面/接口返回"],
      expected: "功能按需求描述正常完成，数据正确落库/展示",
    },
    {
      id: nextId(),
      title: `${req.title} - 非法输入与边界条件`,
      precondition: "系统正常运行",
      steps: ["分别使用空值、超长值、非法格式的输入执行操作"],
      expected: "系统给出明确错误提示，不产生脏数据，不出现 5xx",
    },
    {
      id: nextId(),
      title: `${req.title} - 权限校验`,
      precondition: "存在无权限的测试账号",
      steps: ["使用无权限账号访问该功能"],
      expected: "访问被拒绝并提示无权限，无越权数据泄露",
    }
  );
  return cases;
}

export function testCasesToMarkdown(testCases: TestCase[]): string {
  return testCases
    .map(
      (tc) =>
        `### ${tc.id} ${tc.title}\n\n` +
        `- **前置条件**：${tc.precondition || "无"}\n` +
        `- **步骤**：\n${tc.steps.map((s, i) => `  ${i + 1}. ${s}`).join("\n")}\n` +
        `- **预期结果**：${tc.expected}`
    )
    .join("\n\n");
}
