import { describe, expect, it } from "vitest";
import { sanitizePlan } from "../exec-planner";

describe("sanitizePlan（AI 输出校验）", () => {
  it("合法输出原样通过", () => {
    const p = sanitizePlan(
      { engine: "codex", model: "gpt-5.5", effort: "high", rationale: "复杂重构" },
      ["claude", "codex"]
    );
    expect(p).toMatchObject({ engine: "codex", model: "gpt-5.5", effort: "high" });
    expect(p.source).toBe("ai");
  });

  it("引擎未安装时回退到第一个可用引擎", () => {
    const p = sanitizePlan({ engine: "codex", model: "gpt-5.5" }, ["claude"]);
    expect(p.engine).toBe("claude");
    expect(p.model).toBe("claude-fable-5"); // 回退为该引擎默认（清单第一个）模型
  });

  it("模型不在引擎清单内时回退默认模型", () => {
    const p = sanitizePlan({ engine: "claude", model: "gpt-4o" }, ["claude", "codex"]);
    expect(p.model).toBe("claude-fable-5");
  });

  it("非法强度回退 medium，超长理由被截断", () => {
    const p = sanitizePlan(
      { engine: "claude", effort: "ultra" as never, rationale: "x".repeat(500) },
      ["claude"]
    );
    expect(p.effort).toBe("medium");
    expect(p.rationale.length).toBeLessThanOrEqual(200);
  });
});
