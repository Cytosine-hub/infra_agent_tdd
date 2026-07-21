"use client";

import { useEffect, useState } from "react";
import type { Repo } from "@/lib/types";
import RepoModuleMap from "@/components/RepoModuleMap";

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
  const [provider, setProvider] = useState<"github" | "gitlab">("github");
  const [host, setHost] = useState("");
  const [token, setToken] = useState("");
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

  async function changeToken(id: number, hasToken: boolean) {
    const token = window.prompt(
      hasToken
        ? "更新该仓库的专用访问令牌（留空并确定则清除，改用全局令牌）："
        : "为该仓库设置专用访问令牌（GitLab/GitHub 的 PAT，用于 clone/push/建 Issue/PR）："
    );
    if (token === null) return;
    await fetch("/api/repos", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, action: "set_token", token }),
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
      body: JSON.stringify({ fullName, description, team, provider, host, token }),
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
    setProvider("github");
    setHost("");
    setToken("");
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
        维护可供需求绑定的目标仓库，支持 <b>GitHub</b> 与自建 <b>GitLab</b>。每个仓库根目录需有{" "}
        <code>agent.md</code>（开发规范，可在入驻时自动生成）。GitLab 仓库需绑定专用访问令牌。
      </p>

      <form onSubmit={add} className="card mt-4 flex flex-wrap items-end gap-3 p-5">
        <div className="w-32">
          <label className="label">类型 *</label>
          <select
            className="input"
            value={provider}
            onChange={(e) => setProvider(e.target.value as "github" | "gitlab")}
          >
            <option value="github">GitHub</option>
            <option value="gitlab">GitLab（自建）</option>
          </select>
        </div>
        <div className="min-w-[220px] flex-1">
          <label className="label">仓库路径（owner/repo）*</label>
          <input
            className="input"
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            placeholder={provider === "gitlab" ? "group/subgroup/repo" : "your-org/ops-portal"}
            required
          />
        </div>
        {provider === "gitlab" && (
          <div className="min-w-[220px] flex-1">
            <label className="label">GitLab 域名 *</label>
            <input
              className="input"
              value={host}
              onChange={(e) => setHost(e.target.value)}
              placeholder="http://gitlab.内网域名"
            />
          </div>
        )}
        <div className="min-w-[160px] flex-1">
          <label className="label">说明</label>
          <input
            className="input"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="例如：集成中心主站"
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
        <div className="min-w-[200px] flex-1">
          <label className="label">
            专用令牌{provider === "gitlab" ? " *" : "（可选）"}
          </label>
          <input
            className="input"
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder={
              provider === "gitlab" ? "GitLab PAT（api 权限）" : "留空则用全局 GITHUB_TOKEN；一仓一 token"
            }
            autoComplete="off"
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
          <div key={r.id}>
          <div className="flex items-center justify-between px-5 py-3.5">
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
                <span
                  className={`rounded-full px-2 py-0.5 text-[11px] ${
                    r.provider === "gitlab"
                      ? "bg-orange-50 text-orange-700"
                      : "bg-zinc-100 text-zinc-600"
                  }`}
                  title={r.host}
                >
                  {r.provider === "gitlab" ? `GitLab · ${r.host.replace(/^https?:\/\//, "")}` : "GitHub"}
                </span>
                <span
                  className={`rounded-full px-2 py-0.5 text-[11px] ${
                    r.hasToken ? "bg-emerald-50 text-emerald-700" : "bg-zinc-100 text-zinc-500"
                  }`}
                >
                  {r.hasToken ? "🔑 专用 token" : "全局 token"}
                </span>
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
              <button
                className="text-xs text-zinc-500 hover:underline"
                onClick={() => changeToken(r.id, r.hasToken)}
              >
                {r.hasToken ? "更新 token" : "设置 token"}
              </button>
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
          <RepoModuleMap repoId={r.id} />
          </div>
        ))}
      </div>
    </div>
  );
}
