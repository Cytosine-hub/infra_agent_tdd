import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ExecPlan, Requirement } from "./types";
import { availableEngines, ENGINES } from "./agent-runner";

const execFileP = promisify(execFile);

// 启动开发前，用本地 Claude Code（小模型、无头）根据任务内容评估执行方案：
// 用哪个引擎（claude/codex）、什么模型、什么推理强度。结果供组长修改后再启动。
const EVAL_MODEL = process.env.AGENT_EVAL_MODEL ?? "claude-haiku-4-5-20251001";
const EVAL_TIMEOUT_MS = 90_000;

export const DEFAULT_PLAN: ExecPlan = {
  engine: "claude",
  model: "claude-sonnet-5",
  effort: "medium",
  rationale: "默认方案（未评估或评估不可用）",
  source: "default",
};

export async function evaluateExecPlan(req: Requirement): Promise<ExecPlan> {
  const engines = await availableEngines();
  if (engines.length === 0) return DEFAULT_PLAN;

  const menu = engines
    .map((e) => `- ${e}: 可选模型 ${ENGINES[e].models.join(" / ")}`)
    .join("\n");

  const prompt = [
    "你是研发效能平台的任务调度评估器。根据下面的开发任务，选择最合适的执行方案。",
    "",
    "可用引擎与模型：",
    menu,
    "",
    "推理强度可选：low（简单增删改查/模板化任务）、medium（常规功能开发）、high（复杂逻辑/跨模块/性能与安全敏感）。",
    "选择原则：任务越简单越用小模型+低强度（快且省额度）；涉及复杂算法、大范围重构或高风险变更时才用大模型+高强度。",
    "",
    "# 任务",
    `标题：${req.title}`,
    `所属小组：${req.team}`,
    `需求描述：${req.description}`,
    `验收用例数：${req.testCases?.length ?? 0}`,
    (req.testCases ?? []).map((tc) => `- ${tc.title}`).join("\n"),
    "",
    '只输出一个 JSON 对象，不要输出其他任何内容：{"engine":"...","model":"...","effort":"low|medium|high","rationale":"一句话中文理由"}',
  ].join("\n");

  try {
    const { stdout } = await execFileP(
      "claude",
      ["-p", prompt, "--model", EVAL_MODEL],
      { timeout: EVAL_TIMEOUT_MS, maxBuffer: 1024 * 1024 }
    );
    const jsonText = stdout.slice(stdout.indexOf("{"), stdout.lastIndexOf("}") + 1);
    const raw = JSON.parse(jsonText) as Partial<ExecPlan>;
    return sanitizePlan(raw, engines);
  } catch (err) {
    console.error("执行方案评估失败，使用默认方案:", err);
    return { ...DEFAULT_PLAN, rationale: "评估调用失败，使用默认方案" };
  }
}

// 校验 AI 输出：引擎必须已安装、模型必须在该引擎清单内、强度必须合法
export function sanitizePlan(raw: Partial<ExecPlan>, engines: string[]): ExecPlan {
  const engine = engines.includes(raw.engine ?? "") ? raw.engine! : engines[0];
  const models = ENGINES[engine]?.models ?? [];
  const model = models.includes(raw.model ?? "") ? raw.model! : models[0] ?? "";
  const effort = (["low", "medium", "high"] as const).includes(
    raw.effort as "low" | "medium" | "high"
  )
    ? (raw.effort as ExecPlan["effort"])
    : "medium";
  return {
    engine,
    model,
    effort,
    rationale: (raw.rationale ?? "").slice(0, 200) || "（无理由）",
    source: "ai",
  };
}
