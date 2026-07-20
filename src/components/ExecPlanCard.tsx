"use client";

import { useEffect, useState } from "react";
import type { ExecPlan } from "@/lib/types";

interface EngineInfo {
  name: string;
  models: string[];
}

const EFFORT_LABELS: Record<string, string> = {
  low: "low - 快速",
  medium: "medium - 常规",
  high: "high - 深度",
};

// 启动开发前的执行方案：AI 评估（本地 Claude）给出引擎/模型/推理强度建议，
// 组长可修改后再启动。
export default function ExecPlanCard({
  savedPlan,
  onEvaluate,
  onStart,
  evaluating,
  starting,
  startLabel = "🚀 启动 Agent 开发",
  startingLabel = "创建 Issue 中…",
  disabled = false,
}: {
  savedPlan: ExecPlan | null;
  onEvaluate: () => Promise<ExecPlan | null>;
  onStart: (choice: { engine: string; model: string; effort: string; fallback: boolean }) => void;
  evaluating: boolean;
  starting: boolean;
  startLabel?: string;
  startingLabel?: string;
  disabled?: boolean; // 任务执行中禁用启动（防重复触发）
}) {
  const [engines, setEngines] = useState<EngineInfo[]>([]);
  const [plan, setPlan] = useState<ExecPlan | null>(savedPlan);
  const [engine, setEngine] = useState(savedPlan?.engine ?? "");
  const [model, setModel] = useState(savedPlan?.model ?? "");
  const [effort, setEffort] = useState(savedPlan?.effort ?? "medium");
  const [fallback, setFallback] = useState(true); // 额度受限自动切换备用引擎（默认开）

  useEffect(() => {
    fetch("/api/agent-engines")
      .then((r) => r.json())
      .then((d) => {
        const list: EngineInfo[] = d.engines ?? [];
        setEngines(list);
        if (!engine && list.length > 0) {
          setEngine(list[0].name);
          setModel(list[0].models[0] ?? "");
        }
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const models = engines.find((e) => e.name === engine)?.models ?? [];

  async function evaluate() {
    const p = await onEvaluate();
    if (p) {
      setPlan(p);
      setEngine(p.engine);
      setModel(p.model);
      setEffort(p.effort);
    }
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-zinc-200 bg-zinc-50 p-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-zinc-500">执行方案</span>
        <button
          className="btn-secondary !px-2.5 !py-1 text-xs"
          disabled={evaluating || starting}
          onClick={evaluate}
        >
          {evaluating ? "AI 评估中…" : plan ? "🤖 重新评估" : "🤖 AI 评估"}
        </button>
      </div>

      {plan && (
        <p className="rounded bg-white px-2.5 py-1.5 text-xs leading-relaxed text-zinc-500">
          💡 {plan.rationale}
          <span className="ml-1 text-zinc-300">
            （{plan.source === "ai" ? "AI 建议" : plan.source === "manual" ? "人工指定" : "默认"}）
          </span>
        </p>
      )}

      <div className="grid grid-cols-3 gap-2">
        <div>
          <label className="mb-1 block text-[11px] text-zinc-400">引擎</label>
          <select
            className="input !px-2 !py-1.5 text-xs"
            value={engine}
            onChange={(e) => {
              setEngine(e.target.value);
              const m = engines.find((x) => x.name === e.target.value)?.models ?? [];
              setModel(m[0] ?? "");
            }}
          >
            {engines.map((e) => (
              <option key={e.name} value={e.name}>
                {e.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="mb-1 block text-[11px] text-zinc-400">模型</label>
          <select
            className="input !px-2 !py-1.5 text-xs"
            value={model}
            onChange={(e) => setModel(e.target.value)}
          >
            {models.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="mb-1 block text-[11px] text-zinc-400">推理强度</label>
          <select
            className="input !px-2 !py-1.5 text-xs"
            value={effort}
            onChange={(e) => setEffort(e.target.value as ExecPlan["effort"])}
          >
            {Object.entries(EFFORT_LABELS).map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </div>
      </div>

      <label className="flex cursor-pointer items-center gap-2 text-xs text-zinc-500">
        <input
          type="checkbox"
          checked={fallback}
          onChange={(e) => setFallback(e.target.checked)}
          className="h-3.5 w-3.5 accent-zinc-900"
        />
        额度受限时自动切换备用引擎重试（claude ⇄ codex）
      </label>

      <button
        className="btn-primary"
        disabled={starting || evaluating || disabled || !engine}
        onClick={() => onStart({ engine, model, effort, fallback })}
      >
        {disabled && !starting ? "任务执行中…" : starting ? startingLabel : startLabel}
      </button>
    </div>
  );
}
