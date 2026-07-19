"use client";

import { useEffect, useState } from "react";

interface Team {
  id: number;
  name: string;
}

// 小组管理：管理员维护岗位小组列表（新增小组在此添加）
export default function TeamsManager() {
  const [teams, setTeams] = useState<Team[]>([]);
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  function load() {
    fetch("/api/teams")
      .then((r) => (r.ok ? r.json() : { teams: [] }))
      .then((d) => setTeams(d.teams));
  }
  useEffect(load, []);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const res = await fetch("/api/teams", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    setBusy(false);
    if (!res.ok) {
      setError((await res.json()).error ?? "添加失败");
      return;
    }
    setName("");
    load();
  }

  async function remove(id: number) {
    if (!window.confirm("确定删除该小组？")) return;
    setError("");
    const res = await fetch(`/api/teams?id=${id}`, { method: "DELETE" });
    if (!res.ok) setError((await res.json()).error ?? "删除失败");
    load();
  }

  return (
    <div>
      <p className="text-sm text-zinc-500">
        维护岗位小组列表。账号归属、需求提交、工作台筛选都使用这里的小组；被账号或需求引用的小组不能删除。
      </p>

      <form onSubmit={add} className="card mt-4 flex items-end gap-3 p-5">
        <div className="flex-1">
          <label className="label">小组名称 *</label>
          <input
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="例如：存储组"
            required
          />
        </div>
        <button className="btn-primary" disabled={busy}>
          添加小组
        </button>
      </form>

      {error && (
        <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="card mt-5 divide-y divide-zinc-100">
        {teams.map((t) => (
          <div key={t.id} className="flex items-center justify-between px-5 py-3.5">
            <span className="text-sm font-medium">{t.name}</span>
            <button className="text-xs text-red-500 hover:underline" onClick={() => remove(t.id)}>
              删除
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
