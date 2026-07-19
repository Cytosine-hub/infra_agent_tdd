import { describe, expect, it } from "vitest";
import { effectiveTaskStatus, parseReviewVerdict } from "../agent-runner";

describe("parseReviewVerdict（分级契约）", () => {
  it("[阻断] → changes（触发修复循环）", () => {
    expect(parseReviewVerdict("[阻断] 建议修改\n【阻断】TC-03 无对应测试")).toBe("changes");
  });
  it("[通过] 且仅剩非阻断建议 → approved（停止继续开发）", () => {
    expect(parseReviewVerdict("[通过] 建议合并\n【建议】命名可优化\n【建议】可读性可提升")).toBe(
      "approved"
    );
  });
  it("自由文本兜底：无阻断→approved / 存在阻断→changes", () => {
    expect(parseReviewVerdict("无阻断问题，可以合并")).toBe("approved");
    expect(parseReviewVerdict("存在阻断问题：功能不正确")).toBe("changes");
    expect(parseReviewVerdict("✅ 建议合并\n未发现问题")).toBe("approved");
    expect(parseReviewVerdict("正文里提到\n【阻断】测试未过")).toBe("changes");
  });
  it("无法识别返回空", () => {
    expect(parseReviewVerdict("这是一段无关的话")).toBe("");
  });
});

describe("effectiveTaskStatus", () => {
  it("终态原样返回", () => {
    expect(effectiveTaskStatus({ status: "succeeded", pid: null }, true).status).toBe("succeeded");
    expect(effectiveTaskStatus({ status: "failed", pid: 123 }, false).status).toBe("failed");
  });

  it("running + 执行器离线 → 判为中断失败（覆盖无 pid 的用例生成任务盲区）", () => {
    const r = effectiveTaskStatus({ status: "running", pid: null }, false);
    expect(r.status).toBe("failed");
    expect(r.interrupted).toBe(true);
  });

  it("running + 子进程已死(pid 不存在) → 中断失败", () => {
    const r = effectiveTaskStatus({ status: "running", pid: 2147483646 }, true);
    expect(r.status).toBe("failed");
    expect(r.interrupted).toBe(true);
  });

  it("running + 执行器在线 + 无子进程(进程内跑) → 仍算运行中", () => {
    const r = effectiveTaskStatus({ status: "running", pid: null }, true);
    expect(r.status).toBe("running");
    expect(r.interrupted).toBe(false);
  });
});
