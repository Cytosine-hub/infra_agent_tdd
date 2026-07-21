"use client";

import { useState } from "react";
import Link from "next/link";
import type { RepoModule, Requirement } from "@/lib/types";

const EDITABLE_STATUSES = new Set([
  "submitted",
  "requirement_rejected",
  "requirement_approved",
  "testcases_generated",
  "testcases_rejected",
  "testcases_approved",
]);

export default function RequirementModuleScope({
  requirement,
  modules,
  mapConfirmed,
  isLead,
  classifyActive,
  onSaved,
}: {
  requirement: Requirement;
  modules: RepoModule[];
  mapConfirmed: boolean;
  isLead: boolean;
  classifyActive: boolean;
  onSaved: (requirement: Requirement) => void;
}) {
  const initialKeys = (() => {
    if (requirement.moduleKey) return requirement.moduleKey.split(",").filter(Boolean);
    const suggested = requirement.moduleSuggestion?.moduleKey;
    return suggested && modules.some((module) => module.moduleKey === suggested) ? [suggested] : [];
  })();
  const initialPaths = (() => {
    if (requirement.scopePaths.length > 0) return requirement.scopePaths;
    if (requirement.moduleSuggestion?.scopePaths.length) return requirement.moduleSuggestion.scopePaths;
    return modules.filter((module) => initialKeys.includes(module.moduleKey)).flatMap((module) => module.paths);
  })();
  const [selectedKeys, setSelectedKeys] = useState(initialKeys);
  const [pathsText, setPathsText] = useState(initialPaths.join("\n"));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const canEdit = isLead && EDITABLE_STATUSES.has(requirement.status);

  function toggleModule(moduleKey: string) {
    const next = selectedKeys.includes(moduleKey)
      ? selectedKeys.filter((key) => key !== moduleKey)
      : [...selectedKeys, moduleKey];
    setSelectedKeys(next);
    setPathsText(
      Array.from(
        new Set(
          modules.filter((module) => next.includes(module.moduleKey)).flatMap((module) => module.paths)
        )
      ).join("\n")
    );
  }

  async function lock() {
    setBusy(true);
    setError("");
    const response = await fetch(`/api/requirements/${requirement.id}/scope`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        moduleKeys: selectedKeys,
        scopePaths: pathsText.split(/\r?\n/).map((path) => path.trim()).filter(Boolean),
      }),
    });
    const data = await response.json();
    setBusy(false);
    if (!response.ok) return setError(data.error ?? "锁定失败");
    onSaved(data.requirement);
  }

  const suggestion = requirement.moduleSuggestion;
  const suggestedModule = suggestion
    ? modules.find((module) => module.moduleKey === suggestion.moduleKey)
    : null;

  return (
    <section className="card mt-5 p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-zinc-500">模块归属</h2>
        {requirement.scopeLockedAt ? (
          <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] text-emerald-700">
            已锁定 · {requirement.scopeLockedBy} · {requirement.scopeLockedAt}
          </span>
        ) : classifyActive ? (
          <span className="rounded-full bg-sky-50 px-2 py-0.5 text-[11px] text-sky-700">AI 识别中</span>
        ) : (
          <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[11px] text-amber-700">待组长确认</span>
        )}
      </div>

      {suggestion && (
        <div className="mt-3 border-l-2 border-sky-300 bg-sky-50/60 px-3 py-2.5">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-medium text-sky-900">AI 建议：{suggestedModule?.name ?? suggestion.moduleKey}</span>
            <span className="rounded bg-white px-1.5 py-0.5 text-[11px] text-sky-700">
              置信度 {Math.round(suggestion.confidence * 100)}%
            </span>
          </div>
          <p className="mt-1 text-xs leading-5 text-sky-800">{suggestion.rationale}</p>
        </div>
      )}

      {modules.length === 0 ? (
        <div className="mt-3 border-l-2 border-amber-400 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          仓库尚无模块地图。{isLead && <Link href="/settings" className="ml-1 underline">前往仓库管理补充</Link>}
        </div>
      ) : (
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {modules.map((module) => {
            const checked = selectedKeys.includes(module.moduleKey);
            return (
              <label
                key={module.id}
                className={`flex cursor-pointer gap-2 border px-3 py-2.5 text-sm ${
                  checked ? "border-zinc-700 bg-zinc-50" : "border-zinc-200 bg-white"
                } ${!canEdit ? "cursor-default" : ""}`}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={!canEdit}
                  onChange={() => toggleModule(module.moduleKey)}
                  className="mt-0.5"
                />
                <span className="min-w-0">
                  <span className="font-medium text-zinc-800">{module.name}</span>
                  <code className="ml-1.5 text-[11px] text-zinc-400">{module.moduleKey}</code>
                  <span className="mt-1 block text-[11px] leading-4 text-zinc-500">
                    {module.paths.join("、")}
                  </span>
                </span>
              </label>
            );
          })}
        </div>
      )}

      {selectedKeys.length > 1 && (
        <div className="mt-3 border-l-2 border-amber-400 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          当前为跨模块范围。请确认确需一次交付；否则应拆成独立需求。涉及公共代码时，把对应公共模块或额外路径显式纳入范围。
        </div>
      )}

      {(canEdit || requirement.scopePaths.length > 0) && (
        <div className="mt-3">
          <label className="label">允许路径（仓库相对 glob，每行一个）</label>
          <textarea
            className="input min-h-24 font-mono text-xs"
            value={pathsText}
            readOnly={!canEdit}
            onChange={(event) => setPathsText(event.target.value)}
          />
        </div>
      )}

      {canEdit && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
          {!mapConfirmed ? (
            <p className="text-xs text-amber-700">
              模块地图尚未确认，需先在<Link href="/settings" className="mx-1 underline">仓库管理</Link>确认。
            </p>
          ) : (
            <span className="text-xs text-zinc-400">额外路径会作为组长显式授权一并锁定。</span>
          )}
          <button
            className="btn-primary"
            disabled={busy || !mapConfirmed || selectedKeys.length === 0 || !pathsText.trim()}
            onClick={lock}
          >
            {busy ? "锁定中…" : requirement.scopeLockedAt ? "更新并重新锁定" : "确认并锁定范围"}
          </button>
        </div>
      )}
      {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
    </section>
  );
}
