import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import { deleteAttachment, getAttachment, getRequirement, addEvent } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { apiHandler, badRequest, forbidden } from "@/lib/api";

// 下载/预览附件（登录用户）
export const GET = apiHandler(
  async (_req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    await requireUser();
    const id = Number((await ctx.params).id);
    const att = getAttachment(id);
    if (!att || !fs.existsSync(att.storedPath)) return badRequest("附件不存在");
    const buf = fs.readFileSync(att.storedPath);
    return new NextResponse(new Uint8Array(buf), {
      headers: {
        "Content-Type": att.mime,
        "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(att.filename)}`,
        "Cache-Control": "private, max-age=3600",
      },
    });
  }
);

export const DELETE = apiHandler(
  async (_req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const user = await requireUser();
    const id = Number((await ctx.params).id);
    const att = getAttachment(id);
    if (!att) return badRequest("附件不存在");
    const req = getRequirement(att.requirementId);
    const canDelete =
      user.username === att.uploadedBy ||
      user.role === "admin" ||
      (user.role === "lead" && req && user.team === req.team);
    if (!canDelete) return forbidden("仅上传人或本组组长可删除附件");
    fs.rmSync(att.storedPath, { force: true });
    deleteAttachment(id);
    addEvent(att.requirementId, "attachment_removed", user.username, `删除附件：${att.filename}`);
    return NextResponse.json({ ok: true });
  }
);
