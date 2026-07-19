import { describe, expect, it } from "vitest";
import { effectiveTaskStatus } from "../agent-runner";

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
