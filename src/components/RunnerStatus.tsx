"use client";

import { useEffect, useState } from "react";

// 全局执行器状态指示灯：runner 心跳新鲜=在线，冻结=离线
export default function RunnerStatus() {
  const [online, setOnline] = useState<boolean | null>(null);

  useEffect(() => {
    const load = () =>
      fetch("/api/runner")
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => setOnline(d ? d.online : null))
        .catch(() => setOnline(null));
    load();
    const t = setInterval(load, 8000);
    return () => clearInterval(t);
  }, []);

  if (online === null) return null;
  return (
    <span
      title={online ? "执行器（runner）在线" : "执行器（runner）离线——任务不会推进，请启动 npm run runner"}
      className={`flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs ${
        online ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-700"
      }`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${online ? "bg-emerald-500" : "bg-red-500"}`} />
      执行器{online ? "在线" : "离线"}
    </span>
  );
}
