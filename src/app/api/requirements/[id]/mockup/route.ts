import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import { getRequirement } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { apiHandler, badRequest } from "@/lib/api";
import { mockupPath } from "@/lib/uploads";

// 前端渲染图预览（AI 生成的单文件 HTML 原型）
export const GET = apiHandler(
  async (_req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    await requireUser();
    const id = Number((await ctx.params).id);
    if (!getRequirement(id)) return badRequest("需求不存在");
    const p = mockupPath(id);
    if (!fs.existsSync(p)) return new NextResponse("尚未生成渲染图", { status: 404 });
    return new NextResponse(fs.readFileSync(p, "utf-8"), {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        // 原型是 AI 生成的 HTML，沙箱化展示
        "Content-Security-Policy": "sandbox allow-scripts; default-src 'unsafe-inline' data:;",
      },
    });
  }
);
