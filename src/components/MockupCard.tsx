"use client";

import { useCallback, useEffect, useState } from "react";
import type { AgentTaskRow } from "@/lib/db";

// 前端渲染图卡片：AI 生成的单文件 HTML 原型，评审时预览
export default function MockupCard({
  requirementId,
  mockupTask,
  canGenerate,
  onGenerate,
  busy,
}: {
  requirementId: number;
  mockupTask: AgentTaskRow | null;
  canGenerate: boolean;
  onGenerate: () => void;
  busy: boolean;
}) {
  const [exists, setExists] = useState(false);
  const [checkedAt, setCheckedAt] = useState(0);
  const url = `/api/requirements/${requirementId}/mockup`;

  const check = useCallback(() => {
    fetch(url, { method: "GET", cache: "no-store" }).then((r) => {
      setExists(r.ok);
      setCheckedAt(Date.now());
    });
  }, [url]);
  useEffect(check, [check]);

  const active = !!mockupTask && (mockupTask.status === "queued" || mockupTask.status === "running");
  // 任务刚结束 → 重新检查文件
  useEffect(() => {
    if (!active && mockupTask?.status === "succeeded") check();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, mockupTask?.status]);

  const skipped = mockupTask?.status === "succeeded" && /非前端需求/.test(mockupTask.result ?? "");

  if (!exists && !active && !mockupTask && !canGenerate) return null;

  return (
    <section className="card mt-5 p-5">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-zinc-500">
          前端渲染图
          {mockupTask && (
            <span className="ml-2 rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-[10px] text-zinc-500">
              {mockupTask.engine}
            </span>
          )}
        </h2>
        <div className="flex items-center gap-2">
          {exists && (
            <a href={url} target="_blank" className="text-xs text-sky-600 hover:underline">
              新窗口打开 ↗
            </a>
          )}
          {canGenerate && (
            <button
              className="btn-secondary !px-2.5 !py-1 text-xs"
              disabled={busy || active}
              onClick={onGenerate}
            >
              {active ? "生成中…" : exists ? "🎨 重新生成" : "🎨 生成渲染图"}
            </button>
          )}
        </div>
      </div>

      {active && (
        <div className="mt-3 flex items-center gap-2 rounded-lg border border-sky-100 bg-sky-50/60 px-3 py-2 text-xs text-sky-700">
          <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-sky-500" />
          AI 正在判定需求是否涉及前端并生成渲染原型…
        </div>
      )}
      {mockupTask?.status === "failed" && (
        <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          渲染图生成失败：{mockupTask.error}
        </div>
      )}
      {skipped && !exists && (
        <p className="mt-3 text-xs text-zinc-400">AI 判定该需求不涉及前端界面，未生成渲染图。</p>
      )}

      {exists && (
        <iframe
          key={checkedAt}
          src={url}
          sandbox="allow-scripts"
          className="mt-3 h-[420px] w-full rounded-lg border border-zinc-200 bg-white"
          title="前端渲染图"
        />
      )}
    </section>
  );
}
