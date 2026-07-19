"use client";

import { useEffect, useState } from "react";
import type { Repo } from "@/lib/types";

// 仓库管理：组长/管理员维护可绑定的目标仓库列表
export default function RepoManager() {
  const [repos, setRepos] = useState<Repo[]>([]);
  const [fullName, setFullName] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  function load() {
    fetch("/api/repos")
      .then((r) => (r.ok ? r.json() : { repos: [] }))
      .then((d) => setRepos(d.repos));
  }
  useEffect(load, []);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const res = await fetch("/api/repos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fullName, description }),
    });
    const data = await res.json();
    setBusy(false);
    if (!res.ok) {
      setError(data.error ?? "添加失败");
      return;
    }
    setFullName("");
    setDescription("");
    load();
  }

  async function remove(id: number) {
    if (!window.confirm("确定移除该仓库？不影响已绑定它的历史需求。")) return;
    const res = await fetch(`/api/repos?id=${id}`, { method: "DELETE" });
    if (!res.ok) setError((await res.json()).error ?? "删除失败");
    load();
  }

  return (
    <div>
      <p className="text-sm text-zinc-500">
        维护可供需求绑定的目标 GitHub 仓库。每个仓库根目录需有 <code>agent.md</code>
        （开发规范）并部署 Agent 工作流（见 github-templates/）。
      </p>

      <form onSubmit={add} className="card mt-4 flex items-end gap-3 p-5">
        <div className="flex-1">
          <label className="label">仓库（owner/repo）*</label>
          <input
            className="input"
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            placeholder="your-org/ops-portal"
            required
          />
        </div>
        <div className="flex-1">
          <label className="label">说明</label>
          <input
            className="input"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="例如：运维门户主站"
          />
        </div>
        <button className="btn-primary" disabled={busy}>
          添加
        </button>
      </form>

      {error && (
        <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="card mt-5 divide-y divide-zinc-100">
        {repos.length === 0 && (
          <div className="p-6 text-center text-sm text-zinc-400">
            尚未配置仓库。添加后才能在提交需求时选择绑定。
          </div>
        )}
        {repos.map((r) => (
          <div key={r.id} className="flex items-center justify-between px-5 py-3.5">
            <div>
              <div className="text-sm font-medium">{r.fullName}</div>
              {r.description && <div className="text-xs text-zinc-500">{r.description}</div>}
            </div>
            <button className="text-xs text-red-500 hover:underline" onClick={() => remove(r.id)}>
              移除
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
