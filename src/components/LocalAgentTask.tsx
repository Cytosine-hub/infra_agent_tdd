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
  guard: "安全审查",
  clone: "拉取代码",
  index: "建代码索引",
  develop: "Agent 开发中",
  verify: "运行测试校验",
  push: "推送分支",
  pull_request: "创建 PR",
  comment: "回写评论",
  review: "审查中",
  generate: "生成用例",
  done: "完成",
};

function beatAgo(beatAt: string): string {
  const t = Number(beatAt);
  if (!t) return "";
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  return s < 60 ? `${s} 秒前` : `${Math.round(s / 60)} 分钟前`;
}

// 运行中任务的“最新进度”行：滚动展示 agent/执行的最近一条输出
function LiveProgress({ task, text }: { task: AgentTaskRow; text: string }) {
  if (task.status !== "running") return null;
  return (
    <div className="mt-2 rounded-lg border border-sky-100 bg-sky-50/60 px-3 py-2">
      <div className="flex items-center gap-2 text-[11px] text-sky-700">
        <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-sky-500" />
        {STEP_LABELS[task.step] ?? task.step ?? "运行中"}
        {task.beatAt && <span className="text-sky-400">· 最后活动 {beatAgo(task.beatAt)}</span>}
      </div>
      {text && (
        <div className="mt-1 truncate font-mono text-[11px] text-zinc-600" title={text}>
          {text}
        </div>
      )}
    </div>
  );
}

// 本地 Agent（claude/codex CLI）任务监控：状态、当前步骤、实时日志
export default function LocalAgentTask({
  requirementId,
  canRetrigger,
  onRetrigger,
  onReview,
  canReview,
  busy,
  onTaskFinished,
}: {
  requirementId: number;
  canRetrigger: boolean;
  onRetrigger: () => void;
  onReview: () => void;
  canReview: boolean;
  busy: boolean;
  onTaskFinished?: () => void;
}) {
  const [task, setTask] = useState<AgentTaskRow | null>(null);
  const [review, setReview] = useState<AgentTaskRow | null>(null);
  const [testcases, setTestcases] = useState<AgentTaskRow | null>(null);
  const [log, setLog] = useState("");
  const [progress, setProgress] = useState("");
  const [reviewProgress, setReviewProgress] = useState("");
  const [runnerOnline, setRunnerOnline] = useState(true);
  const [showLog, setShowLog] = useState(false);
  const logRef = useRef<HTMLPreElement>(null);
  const prevActive = useRef<string>("");

  const load = useCallback(() => {
    fetch(`/api/requirements/${requirementId}/agent-task`)
      .then((r) => (r.ok ? r.json() : { task: null, log: "" }))
      .then((d) => {
        setTask(d.task);
        setReview(d.review ?? null);
        setTestcases(d.testcases ?? null);
        setLog(d.log);
        setProgress(d.progress ?? "");
        setReviewProgress(d.reviewProgress ?? "");
        setRunnerOnline(d.runnerOnline !== false);
        // 任何任务从 排队/运行 变为终态 → 通知父组件刷新需求（用例已写入/状态已流转）
        const active = [d.task, d.review, d.testcases]
          .filter((t) => t && (t.status === "queued" || t.status === "running"))
          .map((t) => t.id)
          .join(",");
        if (prevActive.current && prevActive.current !== active) onTaskFinished?.();
        prevActive.current = active;
      });
  }, [requirementId, onTaskFinished]);

  useEffect(() => {
    load();
    const timer = setInterval(load, 5_000);
    return () => clearInterval(timer);
  }, [load]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [log]);

  if (!task && !review && !testcases) return null;

  return (
    <section className="card mt-5 p-5">
      {!runnerOnline && (
        <div className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          ⚠️ 执行器（runner）离线，任务不会推进。请在服务器上启动 <code>npm run runner</code>。
        </div>
      )}

      {/* 用例生成任务 */}
      {testcases && (
        <div className={task ? "mb-4 border-b border-zinc-100 pb-4" : ""}>
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-zinc-500">
              用例生成任务 #{testcases.id}
              <span className="ml-2 rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-[10px] text-zinc-500">
                {testcases.engine}
              </span>
            </h3>
            <span
              className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${(STATUS_STYLE[testcases.status] ?? STATUS_STYLE.queued).cls}`}
            >
              {(STATUS_STYLE[testcases.status] ?? STATUS_STYLE.queued).label}
            </span>
          </div>
          <LiveProgress task={testcases} text={progress} />
          {testcases.result && (
            <p className="mt-1.5 text-xs text-zinc-500">{testcases.result}</p>
          )}
          {testcases.status === "failed" && (
            <p className="mt-1.5 text-xs text-red-600">{testcases.error}</p>
          )}
        </div>
      )}

      {task && renderDev(task)}
    </section>
  );

  function renderDev(task: AgentTaskRow) {
    const style = STATUS_STYLE[task.status] ?? STATUS_STYLE.queued;
    return (
      <div>
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-zinc-500">
          开发任务 #{task.id}
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

      <LiveProgress task={task} text={progress} />

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

      {/* PR 自动审查（默认 codex） */}
      {(review || canReview) && (
        <div className="mt-4 border-t border-zinc-100 pt-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-zinc-500">
              PR 自动审查
              {review && (
                <span className="ml-2 rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-[10px] text-zinc-500">
                  {review.engine}
                </span>
              )}
            </h3>
            <div className="flex items-center gap-2">
              {review && (
                <span
                  className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${(STATUS_STYLE[review.status] ?? STATUS_STYLE.queued).cls}`}
                >
                  {(STATUS_STYLE[review.status] ?? STATUS_STYLE.queued).label}
                </span>
              )}
              {canReview && (
                <button
                  className="btn-secondary !px-2.5 !py-1 text-xs"
                  disabled={busy || review?.status === "running" || review?.status === "queued"}
                  onClick={onReview}
                >
                  {review ? "🧐 重新审查" : "🧐 发起审查"}
                </button>
              )}
            </div>
          </div>
          {review && <LiveProgress task={review} text={reviewProgress} />}
          {review?.status === "failed" && (
            <div className="mt-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
              {review.error ?? "审查失败"}
            </div>
          )}
          {review?.result && (
            <div className="mt-2 whitespace-pre-wrap rounded-lg border border-zinc-200 bg-white p-3 text-xs leading-relaxed text-zinc-700">
              {review.result}
            </div>
          )}
        </div>
      )}
      </div>
    );
  }
}
