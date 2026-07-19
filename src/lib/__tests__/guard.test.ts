import { describe, expect, it } from "vitest";
import { parseGuardVerdict } from "../guard";

describe("parseGuardVerdict（fail-closed 判定解析）", () => {
  it("显式 allowed=true 才放行", () => {
    expect(parseGuardVerdict('{"allowed": true, "reason": "正常开发需求"}').allowed).toBe(true);
  });

  it("allowed=false 拒绝并带理由", () => {
    const v = parseGuardVerdict('{"allowed": false, "reason": "内容生成类请求"}');
    expect(v.allowed).toBe(false);
    expect(v.reason).toContain("内容生成");
  });

  it('非布尔 true（如字符串 "true"、缺失字段）一律拒绝', () => {
    expect(parseGuardVerdict('{"allowed": "true"}').allowed).toBe(false);
    expect(parseGuardVerdict('{"reason": "x"}').allowed).toBe(false);
    expect(parseGuardVerdict('{"allowed": 1}').allowed).toBe(false);
  });

  it("模型输出夹杂多余文字时仍能提取 JSON", () => {
    const v = parseGuardVerdict('审查结果如下：\n{"allowed": true, "reason": "ok"}\n完毕');
    expect(v.allowed).toBe(true);
  });

  it("非法 JSON 抛错（由调用方按失败处理，fail-closed）", () => {
    expect(() => parseGuardVerdict("我觉得可以放行")).toThrow();
  });
});
