import { describe, expect, it } from "vitest";
import { cleanAgentMd } from "../onboard";

describe("cleanAgentMd", () => {
  it("保留正文里的代码块（不被误当整体围栏剥离）", () => {
    const raw = [
      "# agent.md — Demo",
      "",
      "## 2. 代码地图",
      "```",
      "src/main.js  入口",
      "```",
      "",
      "## 3. 模式",
      "正文结束",
    ].join("\n");
    const out = cleanAgentMd(raw);
    expect(out).toContain("# agent.md");
    expect(out).toContain("## 2. 代码地图");
    expect(out).toContain("src/main.js");
    expect(out).toContain("## 3. 模式"); // 关键：代码块之后的内容不能丢
    expect(out).toContain("正文结束");
  });

  it("剥离整体包裹的 ```markdown 围栏", () => {
    const raw = "```markdown\n# agent.md\n内容\n```";
    const out = cleanAgentMd(raw);
    expect(out.startsWith("# agent.md")).toBe(true);
    expect(out).not.toContain("```markdown");
  });

  it("去掉标题前的前言", () => {
    const out = cleanAgentMd("好的，这是生成的文件：\n# agent.md\n正文");
    expect(out.startsWith("# agent.md")).toBe(true);
    expect(out).not.toContain("好的");
  });

  it("末尾补换行", () => {
    expect(cleanAgentMd("# agent.md\nx").endsWith("\n")).toBe(true);
  });
});
