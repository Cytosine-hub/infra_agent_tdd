"use client";

import { useRouter } from "next/navigation";

// 管理员用的岗位筛选下拉框（URL 参数驱动，选「全部岗位」清除筛选）
export default function TeamFilter({
  teams,
  current,
}: {
  teams: string[];
  current: string;
}) {
  const router = useRouter();
  return (
    <select
      className="input !w-auto !py-1.5 text-sm"
      value={current}
      onChange={(e) => {
        const t = e.target.value;
        router.push(t ? `/?team=${encodeURIComponent(t)}` : "/");
      }}
    >
      <option value="">全部岗位</option>
      {teams.map((t) => (
        <option key={t} value={t}>
          {t}
        </option>
      ))}
    </select>
  );
}
