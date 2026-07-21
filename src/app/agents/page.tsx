"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import type { AgentTaskRow } from "@/lib/db";

interface TaskRow extends AgentTaskRow {
  requirementTitle: string;
  requirementTeam: string;
  repo: string;
}

const KIND_LABELS: Record<string, string> = {
  testcases: "📝 用例生成",
  classify: "🧭 模块识别",
  develop: "🛠 开发",
  review: "🧐 PR 审查",
  mockup: "🎨 渲染图",
};

const STATUS_STYLE: Record<string, { label: string; cls: string }> = {
  queued: { label: "排队中", cls: "bg-zinc-100 text-zinc-600" },
  running: { label: "运行中", cls: "bg-sky-100 text-sky-700" },
  succeeded: { label: "成功", cls: "bg-emerald-100 text-emerald-700" },
  failed: { label: "失败", cls: "bg-red-100 text-red-700" },
};

const STEP_LABELS: Record<string, string> = {
  claimed: "已认领",
  guard: "安全审查",
  clone: "拉取代码",
  index: "建代码索引",
  generate: "生成用例",
  mockup: "生成渲染图",
  classify: "模块识别",
  develop: "编码中",
  fix: "按审查修复",
  verify: "测试校验",
  push: "推送分支",
  pull_request: "创建 PR",
  review: "审查中",
  comment: "回写评论",
  done: "完成",
};

// 全局 Agent 监控：所有本地任务（用例生成/开发/审查）的引擎、模型、强度与实时状态
export default function AgentsMonitorPage() {
  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(() => {
    fetch("/api/agent-tasks")
      .then((r) => (r.ok ? r.json() : { tasks: [] }))
      .then((d) => {
        const all: TaskRow[] = d.tasks;
        const order = ["failed", "running", "queued", "succeeded"];
        all.sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status) || b.id - a.id);
        setTasks(all);
        setLoaded(true);
      });
  }, []);

  useEffect(() => {
    load();
    const timer = setInterval(load, 10_000);
    return () => clearInterval(timer);
  }, [load]);

  const active = tasks.filter((t) => t.status === "queued" || t.status === "running").length;
  const failed = tasks.filter((t) => t.status === "failed").length;

  return (
    <div>
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-bold">Agent 监控</h1>
          <p className="mt-1 text-sm text-zinc-500">
            本地 Agent 任务全景（由独立 runner 进程执行，门户重启不中断），10 秒自动刷新。
          </p>
        </div>
        <div className="flex gap-3 text-sm">
          <span className="rounded-full bg-sky-100 px-3 py-1 text-sky-700">进行中 {active}</span>
          <span className="rounded-full bg-red-100 px-3 py-1 text-red-700">失败 {failed}</span>
        </div>
      </div>

      <div className="card mt-6 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-zinc-100 text-left text-xs text-zinc-500">
              <th className="px-5 py-3 font-medium">任务</th>
              <th className="px-3 py-3 font-medium">需求</th>
              <th className="px-3 py-3 font-medium">引擎 / 模型 / 强度</th>
              <th className="px-3 py-3 font-medium">状态</th>
              <th className="px-3 py-3 font-medium">时间</th>
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
            {loaded && tasks.length === 0 && (
              <tr>
                <td colSpan={5} className="px-5 py-8 text-center text-xs text-zinc-400">
                  暂无 Agent 任务
                </td>
              </tr>
            )}
            {tasks.map((t) => {
              const s = STATUS_STYLE[t.status] ?? STATUS_STYLE.queued;
              return (
                <tr key={t.id} className="hover:bg-zinc-50">
                  <td className="px-5 py-3">
                    <span className="text-xs text-zinc-400">#{t.id}</span>
                    <span className="ml-2">{KIND_LABELS[t.kind] ?? t.kind}</span>
                  </td>
                  <td className="px-3 py-3">
                    <Link
                      href={`/requirements/${t.requirementId}`}
                      className="font-medium hover:underline"
                    >
                      #{t.requirementId} {t.requirementTitle}
                    </Link>
                    <div className="text-xs text-zinc-400">
                      {t.requirementTeam}
                      {t.repo && <span className="ml-2 font-mono">{t.repo}</span>}
                    </div>
                  </td>
                  <td className="px-3 py-3">
                    <span className="rounded bg-zinc-100 px-2 py-0.5 font-mono text-xs">
                      {t.engine}
                    </span>
                    {t.model && (
                      <span className="ml-1.5 font-mono text-xs text-zinc-500">{t.model}</span>
                    )}
                    {t.effort && (
                      <span className="ml-1.5 rounded bg-violet-50 px-1.5 py-0.5 text-xs text-violet-600">
                        {t.effort}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-3">
                    <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${s.cls}`}>
                      {s.label}
                      {t.status === "running" && t.step && ` · ${STEP_LABELS[t.step] ?? t.step}`}
                    </span>
                    {t.status === "failed" && t.error && (
                      <div className="mt-1 max-w-64 truncate text-xs text-red-500">{t.error}</div>
                    )}
                  </td>
                  <td className="px-3 py-3 text-xs text-zinc-400">
                    {t.createdAt.slice(5, 16)}
                    {t.finishedAt && <div>→ {t.finishedAt.slice(5, 16)}</div>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
