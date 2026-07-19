import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";
import { currentUser } from "@/lib/session";
import { ROLE_LABELS } from "@/lib/types";
import LogoutButton from "@/components/LogoutButton";
import RunnerStatus from "@/components/RunnerStatus";

export const metadata: Metadata = {
  title: "集成中心需求交付门户",
  description: "需求收集 → 审核 → AI 生成测试用例 → Agent 开发 → CI/CD 的一体化工作流",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const user = await currentUser();
  return (
    <html lang="zh-CN">
      <body className="min-h-screen">
        <header className="sticky top-0 z-10 border-b border-zinc-200 bg-white/90 backdrop-blur">
          <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4">
            <div className="flex items-center gap-8">
              <Link href="/" className="flex items-center gap-2 font-semibold">
                <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-zinc-900 text-sm text-white">
                  集
                </span>
                集成中心需求交付门户
              </Link>
              <nav className="flex items-center gap-5 text-sm text-zinc-600">
                <Link href="/" className="hover:text-zinc-900">
                  工作台
                </Link>
                <Link href="/agents" className="hover:text-zinc-900">
                  Agent 监控
                </Link>
                {user && user.role !== "member" && (
                  <Link href="/settings" className="hover:text-zinc-900">
                    设置
                  </Link>
                )}
              </nav>
            </div>
            {user ? (
              <div className="flex items-center gap-3 text-sm">
                <RunnerStatus />
                <span className="text-zinc-600">
                  {user.displayName}
                  <span className="ml-1.5 rounded-full bg-zinc-100 px-2 py-0.5 text-xs text-zinc-500">
                    {user.team} · {ROLE_LABELS[user.role]}
                  </span>
                </span>
                <LogoutButton />
              </div>
            ) : (
              <Link href="/login" className="btn-primary">
                登录
              </Link>
            )}
          </div>
        </header>
        <main className="mx-auto max-w-6xl px-4 py-8">{children}</main>
      </body>
    </html>
  );
}
