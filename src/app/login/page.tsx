"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ROLE_LABELS, type User } from "@/lib/types";

const PROVIDER_LABELS: Record<string, string> = {
  github: "使用 GitHub 登录",
  gitlab: "使用 GitLab 登录",
};

export default function LoginPage() {
  return (
    <Suspense>
      <LoginInner />
    </Suspense>
  );
}

function LoginInner() {
  const [users, setUsers] = useState<User[]>([]);
  const [providers, setProviders] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const router = useRouter();
  const oauthError = useSearchParams().get("error");

  useEffect(() => {
    fetch("/api/auth/login")
      .then((r) => r.json())
      .then((d) => {
        setUsers(d.users ?? []);
        setProviders(d.providers ?? []);
      });
  }, []);

  async function login(username: string) {
    setBusy(true);
    await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username }),
    });
    router.push("/");
    router.refresh();
  }

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="text-2xl font-bold">登录</h1>

      {oauthError && (
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {oauthError}
        </div>
      )}

      {providers.length > 0 && (
        <div className="card mt-6 p-5">
          <div className="text-sm font-semibold text-zinc-500">代码平台账号登录</div>
          <p className="mt-1 text-xs text-zinc-400">
            首次登录自动创建账号（组员 / 未分配），由管理员在「账号管理」中分配角色与小组。
          </p>
          <div className="mt-3 flex gap-3">
            {providers.map((p) => (
              <a key={p} href={`/api/auth/oauth/${p}`} className="btn-primary">
                {PROVIDER_LABELS[p] ?? p}
              </a>
            ))}
          </div>
        </div>
      )}

      <div className="mt-6">
        <div className="text-sm font-semibold text-zinc-500">
          内置账号{providers.length > 0 ? "（演示 / 应急入口）" : ""}
        </div>
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
          {users
            .filter((u) => u.provider === "local")
            .map((u) => (
              <button
                key={u.username}
                disabled={busy}
                onClick={() => login(u.username)}
                className="card flex flex-col items-start gap-1 p-4 text-left transition hover:border-zinc-400 hover:shadow disabled:opacity-50"
              >
                <span className="font-medium">{u.displayName}</span>
                <span className="text-xs text-zinc-500">
                  {u.team} · {ROLE_LABELS[u.role]}
                </span>
              </button>
            ))}
        </div>
      </div>
    </div>
  );
}
