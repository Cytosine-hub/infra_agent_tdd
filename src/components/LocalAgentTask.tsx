"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentTaskRow } from "@/lib/db";

const STATUS_STYLE: Record<string, { label: string; cls: string }> = {
  queued: { label: "排队中", cls: "bg-zinc-100 text-zinc-600 border-zinc-200" },
  running: { label: "运行中", cls: "bg-sky-50 text-sky-700 border-sky-200" },
  succeeded: { label: "成功", cls: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  failed: { label: "失败", cls: "bg-red-50 text-red-700 border-red-200" },
};

const STEP_LABELS: Record<string, string> = {
  clone: "拉取代码",
  develop: "Agent 开发中",
  verify: "运行测试校验",
  push: "推送分支",
  pull_request: "创建 PR",
  done: "完成",
};

// 本地 Agent（claude/codex CLI）任务监控：状态、当前步骤、实时日志
export default function LocalAgentTask({
  requirementId,
  canRetrigger,
  onRetrigger,
  busy,
}: {
  requirementId: number;
  canRetrigger: boolean;
  onRetrigger: () => void;
  busy: boolean;
}) {
  const [task, setTask] = useState<AgentTaskRow | null>(null);
  const [log, setLog] = useState("");
  const [showLog, setShowLog] = useState(false);
  const logRef = useRef<HTMLPreElement>(null);

  const load = useCallback(() => {
    fetch(`/api/requirements/${requirementId}/agent-task`)
      .then((r) => (r.ok ? r.json() : { task: null, log: "" }))
      .then((d) => {
        setTask(d.task);
        setLog(d.log);
      });
  }, [requirementId]);

  useEffect(() => {
    load();
    const timer = setInterval(load, 5_000);
    return () => clearInterval(timer);
  }, [load]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [log]);

  if (!task) return null;
  const style = STATUS_STYLE[task.status] ?? STATUS_STYLE.queued;

  return (
    <section className="card mt-5 p-5">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-zinc-500">
          本地 Agent 任务 #{task.id}
          <span className="ml-2 rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-[10px] text-zinc-500">
            {task.engine}
            {task.model && ` · ${task.model}`}
            {task.effort && ` · ${task.effort}`}
          </span>
        </h2>
        <span
          className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${style.cls}`}
        >
          {style.label}
          {task.status === "running" && task.step && ` · ${STEP_LABELS[task.step] ?? task.step}`}
        </span>
      </div>

      {task.status === "failed" && (
        <div className="mt-3 flex items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          <span className="min-w-0 truncate">{task.error ?? "任务失败"}</span>
          {canRetrigger && (
            <button
              className="btn-danger shrink-0 !px-2.5 !py-1 text-xs"
              disabled={busy}
              onClick={onRetrigger}
            >
              {busy ? "触发中…" : "🔁 重新触发"}
            </button>
          )}
        </div>
      )}

      <div className="mt-3 flex items-center justify-between text-xs text-zinc-400">
        <span>
          创建:{task.createdAt}
          {task.finishedAt && ` · 结束：${task.finishedAt}`}
        </span>
        <button className="text-sky-600 hover:underline" onClick={() => setShowLog(!showLog)}>
          {showLog ? "收起日志" : "查看日志"}
        </button>
      </div>

      {showLog && (
        <pre
          ref={logRef}
          className="mt-3 max-h-72 overflow-auto rounded-lg bg-zinc-900 p-3 text-[11px] leading-relaxed text-zinc-100"
        >
          {log || "（暂无日志）"}
        </pre>
      )}
    </section>
  );
}
