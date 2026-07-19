"use client";

import { useEffect, useState } from "react";
import type { Repo } from "@/lib/types";

function OnboardBadge({ repo }: { repo: Repo }) {
  const map: Record<string, { label: string; cls: string }> = {
    ready: { label: "✅ 就绪", cls: "bg-emerald-50 text-emerald-700" },
    pending: { label: "⏳ 待入驻", cls: "bg-zinc-100 text-zinc-600" },
    indexing: { label: `⚙️ 入驻中${repo.onboardStep ? "·" + repo.onboardStep : ""}`, cls: "bg-sky-50 text-sky-700" },
    failed: { label: "⚠️ 入驻失败", cls: "bg-red-50 text-red-700" },
  };
  const s = map[repo.onboardStatus] ?? map.ready;
  return <span className={`rounded-full px-2 py-0.5 text-[11px] ${s.cls}`}>{s.label}</span>;
}

// 仓库管理：组长/管理员维护可绑定的目标仓库列表
export default function RepoManager() {
  const [repos, setRepos] = useState<Repo[]>([]);
  const [teams, setTeams] = useState<string[]>([]);
  const [fullName, setFullName] = useState("");
  const [description, setDescription] = useState("");
  const [team, setTeam] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  function load() {
    fetch("/api/repos")
      .then((r) => (r.ok ? r.json() : { repos: [] }))
      .then((d) => setRepos(d.repos));
    fetch("/api/teams")
      .then((r) => (r.ok ? r.json() : { teams: [] }))
      .then((d) => setTeams(d.teams.map((t: { name: string }) => t.name)));
  }
  useEffect(load, []);

  // 有仓库在入驻中时自动刷新
  useEffect(() => {
    if (!repos.some((r) => r.onboardStatus === "pending" || r.onboardStatus === "indexing")) return;
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  }, [repos]);

  async function reonboard(id: number) {
    await fetch("/api/repos", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    load();
  }

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const res = await fetch("/api/repos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fullName, description, team }),
    });
    const data = await res.json();
    setBusy(false);
    if (!res.ok) {
      setError(data.error ?? "添加失败");
      return;
    }
    setFullName("");
    setDescription("");
    setTeam("");
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
        <div className="w-36">
          <label className="label">归属</label>
          <select className="input" value={team} onChange={(e) => setTeam(e.target.value)}>
            <option value="">公共（全员可用）</option>
            {teams.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
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
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
                {r.fullName}
                <span
                  className={`rounded-full px-2 py-0.5 text-[11px] ${
                    r.team ? "bg-amber-50 text-amber-700" : "bg-emerald-50 text-emerald-700"
                  }`}
                >
                  {r.team ? `${r.team}专属` : "公共"}
                </span>
                <OnboardBadge repo={r} />
              </div>
              {r.description && <div className="text-xs text-zinc-500">{r.description}</div>}
              {r.onboardStatus === "failed" && r.onboardError && (
                <div className="mt-0.5 max-w-md truncate text-[11px] text-red-500">
                  入驻失败：{r.onboardError}
                </div>
              )}
              {r.onboardPr && (
                <a
                  href={r.onboardPr}
                  target="_blank"
                  className="text-[11px] text-sky-600 hover:underline"
                >
                  agent.md PR →
                </a>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-3">
              {(r.onboardStatus === "ready" || r.onboardStatus === "failed") && (
                <button
                  className="text-xs text-zinc-500 hover:underline"
                  onClick={() => reonboard(r.id)}
                >
                  重新入驻
                </button>
              )}
              <button className="text-xs text-red-500 hover:underline" onClick={() => remove(r.id)}>
                移除
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
