"use client";

import { useCallback, useEffect, useState } from "react";
import type { RepoModule } from "@/lib/types";

interface Draft {
  moduleKey: string;
  name: string;
  paths: string;
  description: string;
}

const EMPTY_DRAFT: Draft = { moduleKey: "", name: "", paths: "", description: "" };

export default function RepoModuleMap({ repoId }: { repoId: number }) {
  const [modules, setModules] = useState<RepoModule[]>([]);
  const [confirmed, setConfirmed] = useState(false);
  const [mapStatus, setMapStatus] = useState(""); // '' | queued | running：AI 生成任务状态
  const [expanded, setExpanded] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const refresh = useCallback(() => {
    fetch(`/api/repos/${repoId}/modules`)
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (!data) return;
        setModules(data.modules ?? []);
        setConfirmed(Boolean(data.confirmed));
        setMapStatus(data.mapStatus ?? "");
        setLoaded(true);
      });
  }, [repoId]);

  useEffect(refresh, [refresh]);

  // AI 生成进行中时轮询，完成后自动刷新出结果
  useEffect(() => {
    if (mapStatus !== "queued" && mapStatus !== "running") return;
    const timer = setInterval(refresh, 4000);
    return () => clearInterval(timer);
  }, [mapStatus, refresh]);

  const generating = mapStatus === "queued" || mapStatus === "running";

  async function regenerate() {
    if (
      (modules.length > 0 || confirmed) &&
      !window.confirm("AI 将重新分析仓库并覆盖当前模块地图（已确认状态会被重置，需重新确认）。继续？")
    ) {
      return;
    }
    setBusy(true);
    setError("");
    const response = await fetch(`/api/repos/${repoId}/modules/generate`, { method: "POST" });
    const data = await response.json();
    setBusy(false);
    if (!response.ok) return setError(data.error ?? "发起生成失败");
    setMapStatus(data.status ?? "queued");
    setExpanded(true);
  }

  function edit(module: RepoModule) {
    setEditingId(module.id);
    setAdding(false);
    setDraft({
      moduleKey: module.moduleKey,
      name: module.name,
      paths: module.paths.join("\n"),
      description: module.description,
    });
    setError("");
  }

  function startAdd() {
    setAdding(true);
    setEditingId(null);
    setDraft(EMPTY_DRAFT);
    setError("");
  }

  function cancel() {
    setAdding(false);
    setEditingId(null);
    setDraft(EMPTY_DRAFT);
  }

  async function save() {
    setBusy(true);
    setError("");
    const body = {
      ...(adding ? { moduleKey: draft.moduleKey.trim() } : { moduleId: editingId }),
      name: draft.name.trim(),
      paths: draft.paths.split(/\r?\n/).map((path) => path.trim()).filter(Boolean),
      description: draft.description.trim(),
    };
    const response = await fetch(`/api/repos/${repoId}/modules`, {
      method: adding ? "POST" : "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await response.json();
    setBusy(false);
    if (!response.ok) return setError(data.error ?? "保存失败");
    setModules(data.modules);
    setConfirmed(Boolean(data.confirmed));
    cancel();
  }

  async function remove(module: RepoModule) {
    if (!window.confirm(`确认删除模块“${module.name}”？模块地图将需要重新确认。`)) return;
    const response = await fetch(`/api/repos/${repoId}/modules?moduleId=${module.id}`, {
      method: "DELETE",
    });
    const data = await response.json();
    if (!response.ok) return setError(data.error ?? "删除失败");
    setModules(data.modules);
    setConfirmed(Boolean(data.confirmed));
  }

  async function confirmMap() {
    setBusy(true);
    setError("");
    const response = await fetch(`/api/repos/${repoId}/modules`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "confirm" }),
    });
    const data = await response.json();
    setBusy(false);
    if (!response.ok) return setError(data.error ?? "确认失败");
    setModules(data.modules);
    setConfirmed(Boolean(data.confirmed));
  }

  return (
    <div className="border-t border-zinc-100 bg-zinc-50/60 px-5 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <button
          type="button"
          className="text-xs font-medium text-zinc-700 hover:text-zinc-950"
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? "收起模块地图" : `模块地图${loaded ? `（${modules.length}）` : ""}`}
        </button>
        <div className="flex items-center gap-2">
          {generating && (
            <span className="inline-flex items-center gap-1 rounded-full bg-sky-50 px-2 py-0.5 text-[11px] text-sky-700">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-sky-500" />
              AI 生成中…
            </span>
          )}
          {loaded && (
            <span
              className={`rounded-full px-2 py-0.5 text-[11px] ${
                confirmed ? "bg-emerald-50 text-emerald-700" : "bg-amber-100 text-amber-800"
              }`}
            >
              {confirmed ? "已确认" : "待维护者确认"}
            </span>
          )}
        </div>
      </div>

      {expanded && (
        <div className="mt-3">
          {!confirmed && (
            <div className="mb-3 border-l-2 border-amber-400 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              当前为 AI 候选或已发生编辑。确认前，需求评审不能锁定开发范围。
            </div>
          )}
          <div className="divide-y divide-zinc-200 border-y border-zinc-200">
            {modules.length === 0 && (
              <div className="py-4 text-center text-xs text-zinc-400">
                {generating ? "AI 正在分析仓库生成模块地图…" : "暂无模块。可点「AI 生成」自动分析，或手动添加后确认。"}
              </div>
            )}
            {modules.map((module) => (
              <div key={module.id} className="py-3">
                {editingId === module.id ? (
                  <ModuleForm draft={draft} setDraft={setDraft} onSave={save} onCancel={cancel} busy={busy} />
                ) : (
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
                        {module.name}
                        <code className="rounded bg-zinc-200 px-1.5 py-0.5 text-[11px] text-zinc-600">
                          {module.moduleKey}
                        </code>
                      </div>
                      {module.description && (
                        <p className="mt-1 text-xs leading-5 text-zinc-500">{module.description}</p>
                      )}
                      <div className="mt-1.5 flex flex-wrap gap-1.5">
                        {module.paths.map((path) => (
                          <code key={path} className="rounded border border-zinc-200 bg-white px-1.5 py-0.5 text-[11px] text-zinc-600">
                            {path}
                          </code>
                        ))}
                      </div>
                    </div>
                    <div className="flex shrink-0 gap-3">
                      <button className="text-xs text-zinc-500 hover:underline" onClick={() => edit(module)}>
                        编辑
                      </button>
                      <button className="text-xs text-red-500 hover:underline" onClick={() => remove(module)}>
                        删除
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>

          {adding ? (
            <div className="mt-3 border-l-2 border-zinc-300 pl-3">
              <ModuleForm draft={draft} setDraft={setDraft} onSave={save} onCancel={cancel} busy={busy} showKey />
            </div>
          ) : (
            <div className="mt-3 flex flex-wrap justify-between gap-3">
              <div className="flex flex-wrap gap-3">
                <button
                  className="btn-secondary !px-2.5 !py-1 text-xs"
                  onClick={startAdd}
                  disabled={generating}
                >
                  添加模块
                </button>
                <button
                  className="btn-secondary !px-2.5 !py-1 text-xs"
                  onClick={regenerate}
                  disabled={busy || generating}
                  title="复用已有代码索引，仅重新生成模块地图（不重建索引、不改 agent.md）"
                >
                  {generating ? "AI 生成中…" : modules.length > 0 ? "AI 重新生成" : "AI 生成模块地图"}
                </button>
              </div>
              {!confirmed && modules.length > 0 && (
                <button
                  className="btn-primary !px-2.5 !py-1 text-xs"
                  onClick={confirmMap}
                  disabled={busy || generating}
                >
                  {busy ? "确认中…" : "确认整张模块地图"}
                </button>
              )}
            </div>
          )}
          {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
        </div>
      )}
    </div>
  );
}

function ModuleForm({
  draft,
  setDraft,
  onSave,
  onCancel,
  busy,
  showKey = false,
}: {
  draft: Draft;
  setDraft: (draft: Draft) => void;
  onSave: () => void;
  onCancel: () => void;
  busy: boolean;
  showKey?: boolean;
}) {
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {showKey && (
        <input
          className="input"
          placeholder="module key，如 admin-web"
          value={draft.moduleKey}
          onChange={(event) => setDraft({ ...draft, moduleKey: event.target.value })}
        />
      )}
      <input
        className="input"
        placeholder="模块名称"
        value={draft.name}
        onChange={(event) => setDraft({ ...draft, name: event.target.value })}
      />
      <textarea
        className="input min-h-20 font-mono text-xs sm:col-span-2"
        placeholder={"仓库相对路径 glob，每行一个\napps/admin/**"}
        value={draft.paths}
        onChange={(event) => setDraft({ ...draft, paths: event.target.value })}
      />
      <textarea
        className="input min-h-20 sm:col-span-2"
        placeholder="职责与边界"
        value={draft.description}
        onChange={(event) => setDraft({ ...draft, description: event.target.value })}
      />
      <div className="flex justify-end gap-2 sm:col-span-2">
        <button className="btn-secondary !px-2.5 !py-1 text-xs" onClick={onCancel} disabled={busy}>
          取消
        </button>
        <button className="btn-primary !px-2.5 !py-1 text-xs" onClick={onSave} disabled={busy}>
          {busy ? "保存中…" : "保存"}
        </button>
      </div>
    </div>
  );
}
