"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/settings", label: "仓库管理" },
  { href: "/settings/teams", label: "小组管理", adminOnly: true },
  { href: "/settings/users", label: "账号管理", adminOnly: true },
];

export default function SettingsTabs({ isAdmin }: { isAdmin: boolean }) {
  const pathname = usePathname();
  return (
    <div className="mb-6 flex gap-1 border-b border-zinc-200">
      {TABS.filter((t) => !t.adminOnly || isAdmin).map((t) => (
        <Link
          key={t.href}
          href={t.href}
          className={`-mb-px border-b-2 px-4 py-2 text-sm font-medium transition-colors ${
            pathname === t.href
              ? "border-zinc-900 text-zinc-900"
              : "border-transparent text-zinc-500 hover:text-zinc-800"
          }`}
        >
          {t.label}
        </Link>
      ))}
    </div>
  );
}
