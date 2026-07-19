"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

interface Provider {
  name: string;
  label: string;
  enabled: boolean;
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginInner />
    </Suspense>
  );
}

function LoginInner() {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const router = useRouter();
  const oauthError = useSearchParams().get("error");

  useEffect(() => {
    fetch("/api/auth/login")
      .then((r) => r.json())
      .then((d) => setProviders(d.providers ?? []));
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json();
    setBusy(false);
    if (!res.ok) {
      setError(data.error ?? "登录失败");
      return;
    }
    router.push("/");
    router.refresh();
  }

  return (
    <div className="mx-auto mt-8 max-w-sm">
      <div className="mb-6 text-center">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl bg-zinc-900 text-lg font-semibold text-white">
          集
        </div>
        <h1 className="mt-3 text-xl font-bold">集成中心需求交付门户</h1>
        <p className="mt-1 text-sm text-zinc-500">登录以继续</p>
      </div>

      {oauthError && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {oauthError}
        </div>
      )}

      <form onSubmit={submit} className="card flex flex-col gap-4 p-6">
        <div>
          <label className="label">用户名</label>
          <input
            className="input"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            placeholder="用户名"
            required
          />
        </div>
        <div>
          <label className="label">密码</label>
          <input
            className="input"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            placeholder="密码"
            required
          />
        </div>
        {error && (
          <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </div>
        )}
        <button type="submit" className="btn-primary" disabled={busy}>
          {busy ? "登录中…" : "登录"}
        </button>
      </form>

      {/* 第三方登录（图标恒显示，未配置则禁用，后期拓展） */}
      <div className="mt-6">
        <div className="flex items-center gap-3 text-xs text-zinc-400">
          <span className="h-px flex-1 bg-zinc-200" />
          第三方登录
          <span className="h-px flex-1 bg-zinc-200" />
        </div>
        <div className="mt-3 flex justify-center gap-3">
          {providers.map((p) => (
            <ProviderButton key={p.name} provider={p} />
          ))}
        </div>
      </div>
    </div>
  );
}

function ProviderButton({ provider }: { provider: Provider }) {
  const inner = (
    <span className="flex items-center gap-2">
      {provider.name === "github" ? <GithubIcon /> : <GitlabIcon />}
      {provider.label}
    </span>
  );
  if (!provider.enabled) {
    return (
      <span
        title="尚未配置，敬请期待"
        className="flex cursor-not-allowed items-center rounded-lg border border-zinc-200 bg-zinc-50 px-4 py-2 text-sm text-zinc-400"
      >
        {inner}
        <span className="ml-1.5 rounded bg-zinc-200 px-1.5 py-0.5 text-[10px]">即将开放</span>
      </span>
    );
  }
  return (
    <a
      href={`/api/auth/oauth/${provider.name}`}
      className="btn-secondary"
    >
      {inner}
    </a>
  );
}

function GithubIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M12 .5C5.73.5.5 5.73.5 12a11.5 11.5 0 0 0 7.86 10.92c.58.1.79-.25.79-.56v-2c-3.2.7-3.88-1.36-3.88-1.36-.53-1.35-1.3-1.7-1.3-1.7-1.06-.72.08-.71.08-.71 1.17.08 1.79 1.2 1.79 1.2 1.04 1.78 2.73 1.27 3.4.97.1-.75.4-1.27.73-1.56-2.56-.29-5.26-1.28-5.26-5.7 0-1.26.45-2.29 1.19-3.1-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.18 1.18a11 11 0 0 1 5.8 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.84 1.19 3.1 0 4.43-2.7 5.4-5.28 5.69.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 23.5 12C23.5 5.73 18.27.5 12 .5Z" />
    </svg>
  );
}

function GitlabIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="m23.6 9.6-.03-.08-3.27-8.53a.85.85 0 0 0-.84-.53.85.85 0 0 0-.8.63L16.5 7.3H7.5L5.32 1.1a.85.85 0 0 0-.8-.63.85.85 0 0 0-.83.53L.42 9.5l-.03.09a6.07 6.07 0 0 0 2.01 7l.01.01.03.02 4.98 3.73 2.46 1.86 1.5 1.13a1 1 0 0 0 1.2 0l1.5-1.13 2.46-1.86 5.01-3.75.01-.01a6.07 6.07 0 0 0 2.01-7Z" />
    </svg>
  );
}
