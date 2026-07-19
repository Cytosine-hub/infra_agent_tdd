"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import type { AgentRun, Requirement } from "@/lib/types";
import { HEALTH_LABELS, type AgentHealth } from "@/lib/agent-monitor";
import StatusBadge from "@/components/StatusBadge";

interface MonitorRow {
  requirement: Requirement;
  health: AgentHealth;
  latest: AgentRun | null;
}

const HEALTH_COLORS: Record<AgentHealth, string> = {
  idle: "bg-zinc-100 text-zinc-500",
  running: "bg-sky-100 text-sky-700",
  ok: "bg-emerald-100 text-emerald-700",
  failed: "bg-red-100 text-red-700",
};

// 全局 Agent 监控：汇总所有进行中需求的工作流健康度，失败一眼可见
export default function AgentsMonitorPage() {
  const [rows, setRows] = useState<MonitorRow[]>([]);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch("/api/requirements");
    if (!res.ok) return;
    const all: Requirement[] = (await res.json()).requirements;
    const active = all.filter(
      (r) => r.status === "developing" || r.status === "in_review"
    );
    const results = await Promise.all(
      active.map(async (requirement) => {
        try {
          const rr = await fetch(`/api/requirements/${requirement.id}/agent-runs`);
          const d = rr.ok ? await rr.json() : { runs: [], health: "idle" };
          return {
            requirement,
            health: d.health as AgentHealth,
            latest: (d.runs[0] ?? null) as AgentRun | null,
          };
        } catch {
          return { requirement, health: "idle" as AgentHealth, latest: null };
        }
      })
    );
    // 失败的排最前
    const order: AgentHealth[] = ["failed", "running", "idle", "ok"];
    results.sort((a, b) => order.indexOf(a.health) - order.indexOf(b.health));
    setRows(results);
    setLoaded(true);
  }, []);

  useEffect(() => {
    load();
    const timer = setInterval(load, 30_000);
    return () => clearInterval(timer);
  }, [load]);

  return (
    <div>
      <h1 className="text-2xl font-bold">Agent 监控</h1>
      <p className="mt-1 text-sm text-zinc-500">
        所有「开发中 / PR 审查中」需求的工作流运行健康度，每 30 秒自动刷新。失败的需求进入详情页可一键重新触发。
      </p>

      <div className="card mt-6 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-zinc-100 text-left text-xs text-zinc-500">
              <th className="px-5 py-3 font-medium">需求</th>
              <th className="px-3 py-3 font-medium">仓库</th>
              <th className="px-3 py-3 font-medium">状态</th>
              <th className="px-3 py-3 font-medium">Agent 健康度</th>
              <th className="px-3 py-3 font-medium">最近运行</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100">
            {!loaded && (
              <tr>
                <td colSpan={5} className="px-5 py-8 text-center text-xs text-zinc-400">
                  加载中…
                </td>
              </tr>
            )}
            {loaded && rows.length === 0 && (
              <tr>
                <td colSpan={5} className="px-5 py-8 text-center text-xs text-zinc-400">
                  当前没有开发中的需求
                </td>
              </tr>
            )}
            {rows.map(({ requirement: r, health, latest }) => (
              <tr key={r.id} className="hover:bg-zinc-50">
                <td className="px-5 py-3">
                  <Link href={`/requirements/${r.id}`} className="font-medium hover:underline">
                    #{r.id} {r.title}
                  </Link>
                  <span className="ml-2 text-xs text-zinc-400">{r.team}</span>
                </td>
                <td className="px-3 py-3 font-mono text-xs text-zinc-500">{r.repo}</td>
                <td className="px-3 py-3">
                  <StatusBadge status={r.status} />
                </td>
                <td className="px-3 py-3">
                  <span
                    className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${HEALTH_COLORS[health]}`}
                  >
                    {HEALTH_LABELS[health]}
                  </span>
                </td>
                <td className="px-3 py-3 text-xs text-zinc-500">
                  {latest ? (
                    <a href={latest.htmlUrl} target="_blank" className="hover:underline">
                      {latest.name} · {latest.updatedAt.replace("T", " ").slice(0, 16)}
                    </a>
                  ) : (
                    "—"
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
