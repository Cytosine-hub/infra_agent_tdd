"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { type Repo } from "@/lib/types";

export default function NewRequirementPage() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [repos, setRepos] = useState<Repo[]>([]);
  const [teams, setTeams] = useState<string[]>([]);
  const [form, setForm] = useState({
    title: "",
    team: "",
    repo: "",
    priority: "P1",
    description: "",
    testScenarios: "",
  });

  useEffect(() => {
    fetch("/api/repos?forUser=1")
      .then((r) => r.json())
      .then((d) => {
        const list: Repo[] = d.repos ?? [];
        setRepos(list);
        if (list.length > 0) setForm((f) => ({ ...f, repo: f.repo || list[0].fullName }));
      });
    // 默认小组 = 当前用户所属小组（管理员无所属组则留空，强制选择）
    Promise.all([
      fetch("/api/teams").then((r) => r.json()),
      fetch("/api/me").then((r) => (r.ok ? r.json() : { user: null })),
    ]).then(([t, m]) => {
      const names: string[] = (t.teams ?? []).map((x: { name: string }) => x.name);
      setTeams(names);
      const myTeam: string = m.user?.role !== "admin" && names.includes(m.user?.team) ? m.user.team : "";
      setForm((f) => ({ ...f, team: f.team || myTeam }));
    });
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const res = await fetch("/api/requirements", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form),
    });
    const data = await res.json();
    setBusy(false);
    if (!res.ok) {
      setError(data.error ?? "提交失败");
      return;
    }
    router.push(`/requirements/${data.requirement.id}`);
  }

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="text-2xl font-bold">提交需求</h1>
      <p className="mt-1 text-sm text-zinc-500">
        提交后由本组组长审核；写清楚核心测试场景能显著提升 AI 生成测试用例的质量。
      </p>

      <form onSubmit={submit} className="card mt-6 flex flex-col gap-5 p-6">
        <div>
          <label className="label">需求标题 *</label>
          <input
            className="input"
            value={form.title}
            onChange={(e) => setForm({ ...form, title: e.target.value })}
            placeholder="例如：数据库巡检报告页面增加慢 SQL Top 10"
            required
          />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="label">所属小组 *</label>
            <select
              className="input"
              value={form.team}
              onChange={(e) => setForm({ ...form, team: e.target.value })}
              required
            >
              <option value="" disabled>
                请选择小组
              </option>
              {teams.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-zinc-400">新小组由管理员在「小组管理」中添加</p>
          </div>
          <div>
            <label className="label">优先级 *</label>
            <select
              className="input"
              value={form.priority}
              onChange={(e) => setForm({ ...form, priority: e.target.value })}
            >
              <option value="P0">P0 - 紧急</option>
              <option value="P1">P1 - 高</option>
              <option value="P2">P2 - 普通</option>
            </select>
          </div>
        </div>

        <div>
          <label className="label">目标仓库 *</label>
          <select
            className="input"
            value={form.repo}
            onChange={(e) => setForm({ ...form, repo: e.target.value })}
            required
          >
            {repos.length === 0 && <option value="">（无可用仓库）</option>}
            {repos.map((r) => (
              <option key={r.id} value={r.fullName}>
                {r.fullName}
                {r.description ? ` — ${r.description}` : ""}
              </option>
            ))}
          </select>
          {repos.length === 0 && (
            <p className="mt-1 text-xs text-amber-600">
              尚未配置仓库，请组长/管理员先到「仓库管理」添加，否则无法提交。
            </p>
          )}
        </div>

        <div>
          <label className="label">需求描述 *</label>
          <textarea
            className="input min-h-36"
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
            placeholder={
              "描述背景、目标与验收标准。例如：\n在门户的数据库板块新增慢 SQL 展示页面，按实例聚合展示 Top 10 慢 SQL，支持按时间范围筛选……"
            }
            required
          />
        </div>

        <div>
          <label className="label">核心测试场景（可选，每行一条）</label>
          <textarea
            className="input min-h-28"
            value={form.testScenarios}
            onChange={(e) => setForm({ ...form, testScenarios: e.target.value })}
            placeholder={"选择最近 7 天，页面展示对应区间的慢 SQL\n无数据实例展示空态提示\n非本组用户无法看到管理入口"}
          />
        </div>

        {error && (
          <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </div>
        )}

        <div className="flex justify-end gap-3">
          <button type="button" className="btn-secondary" onClick={() => router.back()}>
            取消
          </button>
          <button type="submit" className="btn-primary" disabled={busy}>
            {busy ? "提交中…" : "提交需求"}
          </button>
        </div>
      </form>
    </div>
  );
}
