"use client";

import { useCallback, useEffect, useState } from "react";
import type { AgentRun } from "@/lib/types";
import { HEALTH_LABELS, type AgentHealth } from "@/lib/agent-monitor";

const HEALTH_COLORS: Record<AgentHealth, string> = {
  idle: "bg-zinc-100 text-zinc-500 border-zinc-200",
  running: "bg-sky-50 text-sky-700 border-sky-200",
  ok: "bg-emerald-50 text-emerald-700 border-emerald-200",
  failed: "bg-red-50 text-red-700 border-red-200",
};

function runStatusLabel(r: AgentRun): { text: string; cls: string } {
  if (r.status !== "completed") {
    return { text: r.status === "queued" ? "排队中" : "运行中", cls: "text-sky-600" };
  }
  switch (r.conclusion) {
    case "success":
      return { text: "成功", cls: "text-emerald-600" };
    case "failure":
      return { text: "失败", cls: "text-red-600" };
    case "cancelled":
      return { text: "已取消", cls: "text-amber-600" };
    case "timed_out":
      return { text: "超时", cls: "text-red-600" };
    default:
      return { text: r.conclusion ?? "未知", cls: "text-zinc-500" };
  }
}

// 需求详情页的 Agent 运行监控卡片：30 秒自动刷新；
// 检测到失败/取消/超时时提示组长重新触发，避免任务中断后被遗忘。
export default function AgentRuns({
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
  const [runs, setRuns] = useState<AgentRun[]>([]);
  const [health, setHealth] = useState<AgentHealth>("idle");
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(() => {
    fetch(`/api/requirements/${requirementId}/agent-runs`)
      .then((r) => (r.ok ? r.json() : { runs: [], health: "idle" }))
      .then((d) => {
        setRuns(d.runs);
        setHealth(d.health);
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, [requirementId]);

  useEffect(() => {
    load();
    const timer = setInterval(load, 30_000);
    return () => clearInterval(timer);
  }, [load]);

  return (
    <section className="card mt-5 p-5">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-zinc-500">GitHub Actions 监控（CI / 审查）</h2>
        <span
          className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${HEALTH_COLORS[health]}`}
        >
          {HEALTH_LABELS[health]}
        </span>
      </div>

      {health === "failed" && (
        <div className="mt-3 flex items-center justify-between rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          <span>检测到最近一次运行失败/中断，任务可能停滞</span>
          {canRetrigger && (
            <button className="btn-danger !px-2.5 !py-1 text-xs" disabled={busy} onClick={onRetrigger}>
              {busy ? "触发中…" : "🔁 重新触发开发"}
            </button>
          )}
        </div>
      )}

      <div className="mt-3 flex flex-col gap-2">
        {!loaded && <div className="text-xs text-zinc-400">加载中…</div>}
        {loaded && runs.length === 0 && (
          <div className="text-xs text-zinc-400">
            暂无相关运行记录（Agent 尚未开始，或目标仓库未部署工作流）
          </div>
        )}
        {runs.slice(0, 8).map((r) => {
          const s = runStatusLabel(r);
          return (
            <a
              key={r.id}
              href={r.htmlUrl}
              target="_blank"
              className="flex items-center justify-between rounded-lg border border-zinc-100 px-3 py-2 text-xs transition hover:border-zinc-300"
            >
              <div className="min-w-0">
                <span className="font-medium">{r.name}</span>
                <span className="ml-2 truncate text-zinc-400">{r.displayTitle}</span>
              </div>
              <div className="flex shrink-0 items-center gap-3">
                <span className="text-zinc-400">{r.updatedAt.replace("T", " ").slice(0, 16)}</span>
                <span className={`font-medium ${s.cls}`}>{s.text}</span>
              </div>
            </a>
          );
        })}
      </div>
      <div className="mt-3 text-right text-[11px] text-zinc-300">每 30 秒自动刷新</div>
    </section>
  );
}
