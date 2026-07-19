import { NextResponse } from "next/server";
import { runnerLastBeat, runnerOnline } from "@/lib/db";
import { apiHandler } from "@/lib/api";

// 执行器（runner 守护进程）在线状态，供全局指示灯轮询
export const GET = apiHandler(async () => {
  const now = Date.now();
  return NextResponse.json({ online: runnerOnline(now), lastBeat: runnerLastBeat() });
});
