"use client";

import { useEffect, useState } from "react";
import { ROLE_LABELS, type Role, type User } from "@/lib/types";

const UNASSIGNED = "未分配";

// 账号与角色管理（仅管理员）。演示登录模式下新增账号即可在登录页选择。
// 小组只能从「小组管理」维护的列表中选择，不可随意填写。
export default function UsersManager() {
  const [users, setUsers] = useState<User[]>([]);
  const [teams, setTeams] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({
    username: "",
    displayName: "",
    role: "member",
    team: UNASSIGNED,
    password: "",
  });

  function load() {
    fetch("/api/users")
      .then((r) => (r.ok ? r.json() : { users: [] }))
      .then((d) => setUsers(d.users));
    fetch("/api/teams")
      .then((r) => (r.ok ? r.json() : { teams: [] }))
      .then((d) => setTeams(d.teams.map((t: { name: string }) => t.name)));
  }
  useEffect(load, []);

  // 下拉选项：小组列表 + 未分配；若当前值是历史遗留的未知小组也一并展示，避免显示错乱
  const teamOptions = (current?: string) => {
    const opts = [...teams, UNASSIGNED];
    if (current && !opts.includes(current)) opts.push(current);
    return opts;
  };

  async function call(method: string, body?: unknown, query = "") {
    setBusy(true);
    setError("");
    const res = await fetch(`/api/users${query}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    setBusy(false);
    if (!res.ok) {
      setError((await res.json()).error ?? "操作失败");
      return false;
    }
    load();
    return true;
  }

  return (
    <div>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (await call("POST", form)) {
            setForm({ username: "", displayName: "", role: "member", team: UNASSIGNED, password: "" });
          }
        }}
        className="card flex flex-wrap items-end gap-3 p-5"
      >
        <div className="w-36">
          <label className="label">用户名 *</label>
          <input
            className="input"
            value={form.username}
            onChange={(e) => setForm({ ...form, username: e.target.value })}
            placeholder="zhangsan"
            required
          />
        </div>
        <div className="w-32">
          <label className="label">显示名 *</label>
          <input
            className="input"
            value={form.displayName}
            onChange={(e) => setForm({ ...form, displayName: e.target.value })}
            placeholder="张三"
            required
          />
        </div>
        <div className="w-28">
          <label className="label">角色 *</label>
          <select
            className="input"
            value={form.role}
            onChange={(e) => setForm({ ...form, role: e.target.value })}
          >
            {(Object.keys(ROLE_LABELS) as Role[]).map((r) => (
              <option key={r} value={r}>
                {ROLE_LABELS[r]}
              </option>
            ))}
          </select>
        </div>
        <div className="w-32">
          <label className="label">小组 *</label>
          <select
            className="input"
            value={form.team}
            onChange={(e) => setForm({ ...form, team: e.target.value })}
          >
            {teamOptions().map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>
        <div className="w-32">
          <label className="label">初始密码</label>
          <input
            className="input"
            type="text"
            value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
            placeholder="默认 portal123"
          />
        </div>
        <button className="btn-primary" disabled={busy}>
          添加账号
        </button>
      </form>

      {error && (
        <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="card mt-5 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-zinc-100 text-left text-xs text-zinc-500">
              <th className="px-5 py-3 font-medium">用户名</th>
              <th className="px-3 py-3 font-medium">显示名</th>
              <th className="px-3 py-3 font-medium">角色</th>
              <th className="px-3 py-3 font-medium">小组</th>
              <th className="px-3 py-3"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100">
            {users.map((u) => (
              <tr key={u.id}>
                <td className="px-5 py-2.5 font-mono text-xs">
                  {u.username}
                  {u.provider !== "local" && (
                    <span className="ml-1.5 rounded bg-violet-50 px-1.5 py-0.5 font-sans text-[10px] text-violet-600">
                      {u.provider === "github" ? "GitHub" : "GitLab"}:{u.providerLogin}
                    </span>
                  )}
                </td>
                <td className="px-3 py-2.5">{u.displayName}</td>
                <td className="px-3 py-2.5">
                  <select
                    className="input !w-24 !px-2 !py-1 text-xs"
                    value={u.role}
                    disabled={busy}
                    onChange={(e) => call("PATCH", { id: u.id, role: e.target.value })}
                  >
                    {(Object.keys(ROLE_LABELS) as Role[]).map((r) => (
                      <option key={r} value={r}>
                        {ROLE_LABELS[r]}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="px-3 py-2.5">
                  <select
                    className="input !w-28 !px-2 !py-1 text-xs"
                    value={u.team}
                    disabled={busy}
                    onChange={(e) => call("PATCH", { id: u.id, team: e.target.value })}
                  >
                    {teamOptions(u.team).map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="px-3 py-2.5 text-right whitespace-nowrap">
                  {u.provider === "local" && (
                    <button
                      className="mr-3 text-xs text-zinc-500 hover:underline disabled:opacity-40"
                      disabled={busy}
                      onClick={() => {
                        const pw = window.prompt(`为「${u.displayName}」设置新密码（至少 6 位）：`);
                        if (pw) call("PATCH", { id: u.id, password: pw });
                      }}
                    >
                      重置密码
                    </button>
                  )}
                  <button
                    className="text-xs text-red-500 hover:underline disabled:opacity-40"
                    disabled={busy}
                    onClick={() => {
                      if (window.confirm(`确定删除账号「${u.displayName}」？`)) {
                        call("DELETE", undefined, `?id=${u.id}`);
                      }
                    }}
                  >
                    删除
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
