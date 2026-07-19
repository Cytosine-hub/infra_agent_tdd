import { describe, expect, it } from "vitest";
import { effectiveTaskStatus, parseReviewVerdict } from "../agent-runner";

describe("parseReviewVerdict", () => {
  it("识别建议合并 / 建议修改", () => {
    expect(parseReviewVerdict("✅ 建议合并\n无问题")).toBe("approved");
    expect(parseReviewVerdict("⚠️ 建议修改\n- 某处有问题")).toBe("changes");
  });
  it("建议修改优先于其它（首行判定）", () => {
    expect(parseReviewVerdict("⚠️ 建议修改\n虽然大部分可以合并，但…")).toBe("changes");
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
